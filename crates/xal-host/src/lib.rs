pub mod agent;
mod channel;
mod conversation;
pub mod permissions;
mod tools;
mod workspace;
pub fn sandbox_available() -> bool {
    cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/sandbox-exec").is_file()
}
pub use conversation::*;
pub use tools::PreparedTool;
pub mod contracts;
pub mod decisions;
pub mod recording;
mod registration;

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Duration;

use futures_util::FutureExt;
use tokio_util::sync::CancellationToken;

pub use channel::{Receiver, Sender, channel};
pub use contracts::*;
pub use registration::Registration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Cancelled,
    Denied(String),
    ApprovalRequired(String),
    Failed(String),
    Provider {
        message: String,
        retryable: bool,
        retry_after_ms: Option<u64>,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("cancelled"),
            Self::Provider { message, .. } => formatter.write_str(message),
            Self::Denied(reason) | Self::ApprovalRequired(reason) | Self::Failed(reason) => {
                formatter.write_str(reason)
            }
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Default)]
pub struct Cancellation(CancellationToken);

impl Cancellation {
    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn check(&self) -> Result<()> {
        if self.0.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }

    pub fn child(&self) -> Self {
        Self(self.0.child_token())
    }

    pub async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

pub trait Plugin: Send {
    fn name(&self) -> &str;
    fn register(&mut self, registration: &mut Registration) -> Result<()>;
    fn bootstrap<'a>(&'a mut self, _registration: &'a mut Registration) -> Call<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn shutdown(&mut self) -> Call<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Register,
    Bootstrap,
    Shutdown,
    Dispose,
}

#[derive(Debug)]
pub struct Failure {
    pub plugin: String,
    pub phase: Phase,
    pub error: Error,
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({:?}): {}",
            self.plugin, self.phase, self.error
        )
    }
}

#[derive(PartialEq, Eq)]
enum State {
    Created,
    Registered,
    Ready,
    Stopped,
}

struct Entry {
    name: String,
    plugin: Box<dyn Plugin>,
    registration: Registration,
    state: State,
}

impl Entry {
    fn fail(&self, phase: Phase, error: Error, failures: &mut Vec<Failure>) {
        failures.push(Failure {
            plugin: self.name.clone(),
            phase,
            error,
        });
    }

    async fn stop(&mut self, failures: &mut Vec<Failure>) {
        if self.state == State::Stopped {
            return;
        }
        self.registration.cancellation.cancel();
        if self.state != State::Created {
            let result = bounded_cleanup(async { self.plugin.shutdown().await }).await;
            if let Err(error) = result {
                self.fail(Phase::Shutdown, error, failures);
            }
        }
        while let Some(task) = self.registration.tasks.pop() {
            task.abort();
            match task.await {
                Ok(Ok(())) => {}
                Ok(Err(Error::Cancelled)) => {}
                Ok(Err(error)) => self.fail(Phase::Dispose, error, failures),
                Err(error) if error.is_cancelled() => {}
                Err(_) => self.fail(
                    Phase::Dispose,
                    Error::Failed("owned task panicked".into()),
                    failures,
                ),
            }
        }
        while let Some(dispose) = self.registration.disposers.pop() {
            if let Err(error) = bounded_cleanup(async { dispose().await }).await {
                self.fail(Phase::Dispose, error, failures);
            }
        }
        self.registration.clear();
        self.state = State::Stopped;
    }
}

pub struct Host {
    workspaces: std::sync::Mutex<std::collections::BTreeMap<String, std::path::PathBuf>>,
    entries: Vec<Entry>,
    cancellation: Cancellation,
    state: State,
    failures: Vec<Failure>,
    permissions: Option<permissions::Permissions>,
    output: tools::OutputPolicy,
    decision_settings: Option<decisions::Settings>,
    pub recorder: Option<std::sync::Arc<recording::Recorder>>,
}

impl Host {
    pub fn new(plugins: Vec<Box<dyn Plugin>>, cancellation: Cancellation) -> Self {
        Self {
            workspaces: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            entries: plugins
                .into_iter()
                .map(|plugin| Entry {
                    name: plugin.name().into(),
                    plugin,
                    registration: Registration::new(cancellation.child()),
                    state: State::Created,
                })
                .collect(),
            cancellation,
            state: State::Created,
            failures: Vec::new(),
            permissions: None,
            output: tools::OutputPolicy::default(),
            decision_settings: None,
            recorder: None,
        }
    }

    pub fn permissions(&mut self, permissions: permissions::Permissions) {
        self.permissions = Some(permissions);
    }

    pub async fn start(&mut self) -> Result<()> {
        if self.state != State::Created {
            return Err(Error::Failed("host has already started or stopped".into()));
        }
        let mut names = HashSet::new();
        let mut capabilities = HashSet::new();
        for entry in &mut self.entries {
            let result = if !valid_name(&entry.name) || !names.insert(entry.name.clone()) {
                Err(Error::Failed("invalid or duplicate plugin name".into()))
            } else {
                entry.state = State::Registered;
                entry.registration.cancellation.check().and_then(|()| {
                    guarded(|| entry.plugin.register(&mut entry.registration))?;
                    entry.registration.cancellation.check()?;
                    entry.registration.check(&capabilities)
                })
            };
            if let Err(error) = result {
                entry.fail(Phase::Register, error, &mut self.failures);
                entry.stop(&mut self.failures).await;
                continue;
            }
            capabilities.extend(entry.registration.keys());
        }
        for entry in &mut self.entries {
            if entry.state != State::Registered {
                continue;
            }
            for key in entry.registration.keys() {
                capabilities.remove(&key);
            }
            let cancellation = entry.registration.cancellation.clone();
            let result = run(&cancellation, async {
                entry.plugin.bootstrap(&mut entry.registration).await?;
                entry.registration.check(&capabilities)
            })
            .await;
            if let Err(error) = result {
                entry.fail(Phase::Bootstrap, error, &mut self.failures);
                entry.stop(&mut self.failures).await;
                continue;
            }
            capabilities.extend(entry.registration.keys());
            entry.state = State::Ready;
        }
        self.state = State::Ready;
        if self.cancellation.check().is_err() {
            self.shutdown().await;
            return Err(Error::Cancelled);
        }
        if !self.failures.is_empty() {
            return Err(Error::Failed("plugin startup failed".into()));
        }
        Ok(())
    }

    fn ready(&self) -> impl Iterator<Item = &Entry> {
        self.entries
            .iter()
            .filter(|entry| entry.state == State::Ready)
    }

    fn check(&self) -> Result<()> {
        self.cancellation.check()?;
        if self.state != State::Ready {
            return Err(Error::Failed("host is not ready".into()));
        }
        Ok(())
    }

    fn command_owners(&self) -> std::sync::Arc<std::collections::BTreeMap<String, String>> {
        std::sync::Arc::new(
            self.ready()
                .flat_map(|entry| {
                    entry
                        .registration
                        .commands
                        .keys()
                        .map(|name| (name.clone(), entry.name.clone()))
                })
                .collect(),
        )
    }

    pub fn commands(&self) -> Vec<(&str, &str)> {
        self.ready()
            .flat_map(|entry| {
                entry
                    .registration
                    .commands
                    .iter()
                    .map(|(name, command)| (name.as_str(), command.description.as_str()))
            })
            .collect()
    }

    pub async fn execute(&self, name: &str, args: &[String]) -> Result<String> {
        self.check()?;
        for entry in self.ready() {
            if let Some(command) = entry.registration.commands.get(name) {
                let cancellation = entry.registration.cancellation.child();
                let _guard = cancellation.0.clone().drop_guard();
                let operation = AssertUnwindSafe(async {
                    (command.run)(args.to_vec(), cancellation.clone()).await
                })
                .catch_unwind();
                tokio::pin!(operation);
                let result = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        tokio::time::timeout(Duration::from_secs(5), &mut operation).await
                            .map_err(|_| Error::Failed("command did not settle within 5 seconds of cancellation".into()))?
                    }
                    result = &mut operation => result,
                }.unwrap_or_else(|_| Err(Error::Failed("plugin callback panicked".into())));
                let output = result?;
                cancellation.check()?;
                return Ok(output);
            }
        }
        Err(Error::Failed(format!("unknown command: {name}")))
    }

    pub fn session(
        &self,
        id: String,
        cwd: std::path::PathBuf,
        kind: SessionKind,
        read_only: bool,
    ) -> Result<Session> {
        self.check()?;
        if id.is_empty() {
            return Err(Error::Failed("session ID must not be empty".into()));
        }
        self.workspaces
            .lock()
            .map_err(|_| Error::Failed("workspace state lock poisoned".into()))?
            .insert(id.clone(), cwd.clone());
        Ok(Session {
            id,
            cwd,
            kind,
            read_only,
            cancellation: self.cancellation.child(),
        })
    }

    pub fn publish(&self, event: Event) -> Result<()> {
        self.check()?;
        for entry in self.ready() {
            for sender in &entry.registration.subscriptions {
                sender.try_send(event.clone())?;
            }
        }
        Ok(())
    }

    async fn call<I, O>(
        &self,
        entry: &Entry,
        handler: &Handler<I, O>,
        input: I,
        session: &Session,
    ) -> Result<O> {
        self.check()?;
        let context = Context {
            command_owners: self.command_owners(),
            workspace: None,
            session: self.effective_session(session)?,
            cancellation: session.cancellation.child(),
            output: None,
            speculative: false,
            decisions: self.decision_service()?,
            observation: None,
        };
        let cancellation = context.cancellation.clone();
        let _guard = cancellation.0.clone().drop_guard();
        run(
            &entry.registration.cancellation,
            run(&cancellation, async { handler(input, context).await }),
        )
        .await
    }

    pub async fn hook(&self, mut input: HookInput, session: &Session) -> Result<HookInput> {
        self.check()?;
        for entry in self.ready() {
            for (_, handler) in &entry.registration.hooks {
                match self.call(entry, handler, input.clone(), session).await? {
                    HookResult::Continue => {}
                    HookResult::Block(reason) => return Err(Error::Denied(reason)),
                    HookResult::ReplacePrompt(text) => match &mut input {
                        HookInput::Prompt { text: current } => *current = text,
                        _ => return Err(Error::Failed("invalid hook result for event".into())),
                    },
                    HookResult::ReplaceArguments(args) => match &mut input {
                        HookInput::BeforeTool { args: current, .. } => *current = args,
                        _ => return Err(Error::Failed("invalid hook result for event".into())),
                    },
                    HookResult::ReplaceOutput(output) => match &mut input {
                        HookInput::AfterTool {
                            output: current, ..
                        } => *current = output,
                        _ => return Err(Error::Failed("invalid hook result for event".into())),
                    },
                }
            }
        }
        Ok(input)
    }

    pub async fn provider(
        &self,
        name: &str,
        request: ProviderRequest,
        session: &Session,
        sender: Sender<ProviderEvent>,
    ) -> Result<()> {
        self.check()?;
        for entry in self.ready() {
            if let Some(provider) = entry.registration.providers.get(name) {
                if !provider.models.contains(&request.model) {
                    return Err(Error::Failed("unknown provider model".into()));
                }
                let observation = self
                    .recorder
                    .as_ref()
                    .map(|recorder| {
                        recorder.start(
                            name,
                            &request.model,
                            session,
                            request.phase,
                            request.thinking.as_deref(),
                            request.attempt,
                        )
                    })
                    .transpose()?;
                let sender = if let Some(observation) = &observation {
                    observation.shape(&request)?;
                    let observation = observation.clone();
                    sender.observe(std::sync::Arc::new(move |event| observation.event(event)))
                } else {
                    sender
                };
                let context = Context {
                    command_owners: self.command_owners(),
                    workspace: None,
                    session: self.effective_session(session)?,
                    cancellation: session.cancellation.child(),
                    output: None,
                    speculative: false,
                    decisions: None,
                    observation: observation.clone(),
                };
                let cancellation = context.cancellation.clone();
                let _guard = cancellation.0.clone().drop_guard();
                let result = run(
                    &entry.registration.cancellation,
                    run(&cancellation, async {
                        (provider.stream)(request, context, sender).await
                    }),
                )
                .await;
                let result = if let Some(settle) = &provider.settle {
                    let settled = AssertUnwindSafe(async { settle().await })
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            Err(Error::Failed("provider settlement panicked".into()))
                        });
                    match (result, settled) {
                        (result, Ok(())) => result,
                        (Ok(()), Err(error)) => Err(error),
                        (Err(error), Err(settlement)) => Err(Error::Failed(format!(
                            "{error}; provider settlement failed: {settlement}"
                        ))),
                    }
                } else {
                    result
                };
                if let Some(observation) = observation {
                    observation.finish(&result)?;
                }
                result?;
                return self.publish(Event::ProviderFinished {
                    session: session.id.clone(),
                    provider: name.into(),
                });
            }
        }
        Err(Error::Failed(format!("unknown provider: {name}")))
    }

    pub async fn decide(
        &self,
        name: &str,
        request: DecisionRequest,
        session: &Session,
    ) -> Result<DecisionResponse> {
        if name == "typesafe" {
            return self
                .decision_service()?
                .ok_or_else(|| Error::Failed("TypeSafe AI is off".into()))?
                .evaluate(request, session)
                .await;
        }
        for entry in self.ready() {
            if let Some(handler) = entry.registration.decisions.get(name) {
                return self.call(entry, handler, request, session).await;
            }
        }
        Err(Error::Failed(format!("unknown decision provider: {name}")))
    }

    pub fn warnings(&self) -> Vec<&str> {
        self.ready()
            .flat_map(|entry| entry.registration.warnings.iter().map(String::as_str))
            .collect()
    }

    pub fn tool_title(&self, name: &str, args: &JsonObject, session: &Session) -> Result<String> {
        self.check()?;
        let session = self.effective_session(session)?;
        let Some((_, tool)) = self.tool_catalog(&session)?.remove(name) else {
            return Ok(name.into());
        };
        if !guarded(|| (tool.available)(&session))? {
            return Ok(name.into());
        }
        match &tool.title {
            Some(title) => guarded(|| title(args, &session)),
            None => Ok(name.into()),
        }
    }

    pub async fn render(
        &self,
        name: &str,
        contribution: UiContribution,
        session: &Session,
    ) -> Result<String> {
        for entry in self.ready() {
            if let Some(handler) = entry.registration.ui.get(name) {
                return self.call(entry, handler, contribution, session).await;
            }
        }
        Err(Error::Failed(format!("unknown UI: {name}")))
    }

    pub fn prompts(&self) -> Result<Vec<&str>> {
        self.check()?;
        Ok(self
            .ready()
            .flat_map(|entry| entry.registration.prompts.values().map(String::as_str))
            .collect())
    }

    pub fn session_prompts(&self, session: &Session) -> Result<Vec<String>> {
        self.check()?;
        let session = self.effective_session(session)?;
        let mut prompts = Vec::new();
        for entry in self.ready() {
            prompts.extend(entry.registration.prompts.values().cloned());
            for (_, source) in &entry.registration.prompt_sources {
                let text = guarded(|| source(&session))?;
                if !text.is_empty() {
                    prompts.push(text);
                }
            }
        }
        Ok(prompts)
    }

    pub async fn shutdown(&mut self) {
        self.cancellation.cancel();
        for entry in self.entries.iter_mut().rev() {
            entry.stop(&mut self.failures).await;
        }
        self.state = State::Stopped;
    }

    pub fn failures(&self) -> &[Failure] {
        &self.failures
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.cancellation.cancel();
        for entry in &mut self.entries {
            for task in &entry.registration.tasks {
                task.abort();
            }
        }
        if self.state != State::Stopped && self.state != State::Created {
            eprintln!("native host dropped without explicit asynchronous shutdown");
        }
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn guarded<T>(call: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(call))
        .unwrap_or_else(|_| Err(Error::Failed("plugin callback panicked".into())))
}

async fn run<T>(cancellation: &Cancellation, future: impl Future<Output = Result<T>>) -> Result<T> {
    cancellation.check()?;
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::Cancelled),
        result = AssertUnwindSafe(future).catch_unwind() => result.unwrap_or_else(|_| Err(Error::Failed("plugin callback panicked".into()))),
    };
    cancellation.check()?;
    result
}

async fn bounded_cleanup(future: impl Future<Output = Result<()>>) -> Result<()> {
    match tokio::time::timeout(
        Duration::from_secs(5),
        AssertUnwindSafe(future).catch_unwind(),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(Error::Failed("plugin cleanup panicked".into())),
        Err(_) => Err(Error::Failed("plugin cleanup timed out".into())),
    }
}
