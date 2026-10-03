use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use serde_json::Value;

use crate::*;

pub struct PreparedTool {
    pub(crate) name: String,
    session_id: String,
    cwd: std::path::PathBuf,
    read_only: bool,
    pub(crate) args: JsonObject,
    pub(crate) effects: Effects,
}

pub(crate) struct OutputPolicy {
    redactor: std::sync::Arc<xal_services::redactor::Redactor>,
    directory: Option<std::path::PathBuf>,
}

impl Default for OutputPolicy {
    fn default() -> Self {
        Self {
            redactor: std::sync::Arc::new(
                xal_services::redactor::Redactor::new(Vec::new())
                    .expect("empty redaction set is valid"),
            ),
            directory: None,
        }
    }
}

impl Host {
    pub fn output_policy(
        &mut self,
        redactor: std::sync::Arc<xal_services::redactor::Redactor>,
        directory: std::path::PathBuf,
    ) {
        self.output = OutputPolicy {
            redactor,
            directory: Some(directory),
        };
    }

    pub fn tools(&self, session: &Session) -> Result<Vec<ToolDefinition>> {
        self.check()?;
        let mut tools = Vec::new();
        for (name, tool) in self
            .ready()
            .flat_map(|entry| entry.registration.tools.iter())
        {
            if !guarded(|| Ok((tool.available)(session)))? {
                continue;
            }
            tools.push(ToolDefinition {
                name: name.clone(),
                description: tool.description.clone(),
                parameters: tool.parameters.clone(),
            });
        }
        Ok(tools)
    }

    pub async fn prepare_tool(
        &self,
        name: &str,
        args: JsonObject,
        session: &Session,
    ) -> Result<PreparedTool> {
        self.check()?;
        session.cancellation.check()?;
        let tool = self
            .ready()
            .find_map(|entry| entry.registration.tools.get(name))
            .ok_or_else(|| Error::Failed(format!("unknown tool: {name}")))?;
        if !guarded(|| Ok((tool.available)(session)))? {
            return Err(Error::Denied(format!(
                "{name} is known but unavailable in this session"
            )));
        }
        let HookInput::BeforeTool { args, .. } = self
            .hook(
                HookInput::BeforeTool {
                    tool: name.into(),
                    args,
                },
                session,
            )
            .await?
        else {
            return Err(Error::Failed("invalid before-tool hook result".into()));
        };
        let args = args
            .iter()
            .map(|(key, value)| {
                (
                    self.output.redactor.redact(key),
                    self.output.redactor.redact_json(value),
                )
            })
            .collect::<JsonObject>();
        xal_services::schema::validate(
            &Value::Object(tool.parameters.clone()),
            &Value::Object(args.clone()),
        )
        .map_err(|error| Error::Failed(error.to_string()))?;
        let effects = guarded(|| Ok((tool.effects)(&args)))?;
        if session.read_only && effects == Effects::Write {
            return Err(Error::Denied(
                "tool is unavailable in a read-only session".into(),
            ));
        }
        Ok(PreparedTool {
            name: name.into(),
            session_id: session.id.clone(),
            cwd: session.cwd.clone(),
            read_only: session.read_only,
            args,
            effects,
        })
    }

    pub async fn authorize_tool(&self, prepared: &PreparedTool, session: &Session) -> Result<()> {
        self.check()?;
        session.cancellation.check()?;
        if prepared.session_id != session.id
            || prepared.cwd != session.cwd
            || prepared.read_only != session.read_only
        {
            return Err(Error::Denied(
                "prepared tool belongs to another session".into(),
            ));
        }
        if session.read_only && prepared.effects == Effects::Write {
            return Err(Error::Denied(
                "tool is unavailable in a read-only session".into(),
            ));
        }
        let request = PermissionRequest {
            tool: prepared.name.clone(),
            args: prepared.args.clone(),
            read_only: prepared.effects == Effects::Read,
        };
        let mut decision = match &self.permissions {
            Some(permissions) => permissions.evaluate(&request, &session.cwd)?,
            None => PolicyDecision::Abstain,
        };
        if let PolicyDecision::Deny(reason) = decision {
            return Err(Error::Denied(reason));
        }
        for owner in self.ready() {
            for policy in owner.registration.policies.values() {
                match self.call(owner, policy, request.clone(), session).await? {
                    PolicyDecision::Deny(reason) => return Err(Error::Denied(reason)),
                    PolicyDecision::Ask(reason) => decision = PolicyDecision::Ask(reason),
                    PolicyDecision::Allow if decision == PolicyDecision::Abstain => {
                        decision = PolicyDecision::Allow
                    }
                    PolicyDecision::Allow | PolicyDecision::Abstain => {}
                }
            }
        }
        if matches!(decision, PolicyDecision::Ask(_))
            && self
                .permissions
                .as_ref()
                .is_some_and(|permissions| permissions.skip_ask)
        {
            return Ok(());
        }
        match decision {
            PolicyDecision::Allow => Ok(()),
            PolicyDecision::Ask(reason) | PolicyDecision::Deny(reason) => {
                Err(Error::ApprovalRequired(reason))
            }
            PolicyDecision::Abstain => Err(Error::ApprovalRequired(format!(
                "permission required for {}",
                prepared.name
            ))),
        }
    }

    pub async fn execute_tool(
        &self,
        prepared: PreparedTool,
        session: &Session,
    ) -> Result<ToolResult> {
        self.execute_tool_streaming(prepared, session, None).await
    }

    pub async fn execute_tool_streaming(
        &self,
        prepared: PreparedTool,
        session: &Session,
        output: Option<Sender<String>>,
    ) -> Result<ToolResult> {
        self.check()?;
        self.authorize_tool(&prepared, session).await?;
        session.cancellation.check()?;
        let entry = self
            .ready()
            .find(|entry| entry.registration.tools.contains_key(&prepared.name))
            .ok_or_else(|| Error::Failed(format!("tool removed: {}", prepared.name)))?;
        let tool = &entry.registration.tools[&prepared.name];
        let cancellation = session.cancellation.child();
        let (sender, mut receiver) = channel(16, Cancellation::default())?;
        let context = Context {
            session: session.clone(),
            cancellation: cancellation.clone(),
            output: output.as_ref().map(|_| sender),
        };
        let operation = async {
            AssertUnwindSafe(async { (tool.run)(prepared.args, context).await })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(Error::Failed("plugin callback panicked".into())))
        };
        tokio::pin!(operation);
        let supervised = async {
            tokio::select! {
                biased;
                () = session.cancellation.cancelled() => { cancellation.cancel(); self.settle_tool(operation, session).await }
                () = entry.registration.cancellation.cancelled() => { cancellation.cancel(); self.settle_tool(operation, session).await }
                result = &mut operation => result,
            }
        };
        tokio::pin!(supervised);
        let mut settled = None;
        let mut closed = false;
        let mut stream = self.output.redactor.stream();
        let mut delivered = 0;
        while settled.is_none() || !closed {
            tokio::select! {
                result = &mut supervised, if settled.is_none() => { settled = Some(result); receiver.close(); },
                delta = receiver.recv(), if !closed => {
                    match delta? {
                        Some(delta) => {
                            let delta = stream.write(&delta);
                            if let Some(output) = &output {
                                let delta = crate::agent::storage::prefix(&delta, (20 * 1024usize).saturating_sub(delivered));
                                delivered += delta.len();
                                if !delta.is_empty()
                                    && let Err(error) = forward(output, delta.into(), &cancellation, &entry.registration.cancellation).await {
                                        cancellation.cancel();
                                        session.cancellation.cancel();
                                        if settled.is_none() { supervised.await?; }
                                        return Err(error);
                                    }
                            }
                        }
                        None => closed = true,
                    }
                }
            }
        }
        if let Some(output) = &output {
            let tail = stream.end();
            let tail =
                crate::agent::storage::prefix(&tail, (20 * 1024usize).saturating_sub(delivered));
            if !tail.is_empty() {
                forward(
                    output,
                    tail.into(),
                    &cancellation,
                    &entry.registration.cancellation,
                )
                .await?;
            }
        }
        let result = settled.ok_or_else(|| Error::Failed("tool result missing".into()))??;
        cancellation.check()?;
        cancellation.cancel();
        self.finish_tool(&prepared.name, result, session).await
    }

    pub(crate) async fn prepare_output(
        &self,
        args: JsonObject,
        session: &Session,
    ) -> Result<PreparedTool> {
        let HookInput::BeforeTool { args, .. } = self
            .hook(
                HookInput::BeforeTool {
                    tool: "submit_output".into(),
                    args,
                },
                session,
            )
            .await?
        else {
            return Err(Error::Failed("invalid before-tool hook result".into()));
        };
        let args = args
            .iter()
            .map(|(key, value)| {
                (
                    self.output.redactor.redact(key),
                    self.output.redactor.redact_json(value),
                )
            })
            .collect();
        Ok(PreparedTool {
            name: "submit_output".into(),
            session_id: session.id.clone(),
            cwd: session.cwd.clone(),
            read_only: session.read_only,
            args,
            effects: Effects::Read,
        })
    }

    pub(crate) async fn finish_tool(
        &self,
        name: &str,
        result: ToolResult,
        session: &Session,
    ) -> Result<ToolResult> {
        let output = self.output.redactor.redact(&result.output);
        let HookInput::AfterTool { output, .. } = self
            .hook(
                HookInput::AfterTool {
                    tool: name.into(),
                    output,
                },
                session,
            )
            .await?
        else {
            return Err(Error::Failed("invalid after-tool hook result".into()));
        };
        let output = self.output.redactor.redact(&output);
        let maximum = if name == "bash" { 20 * 1024 } else { 50 * 1024 };
        let output = match &self.output.directory {
            Some(directory) => {
                crate::agent::storage::bound_output(&directory.join(&session.id), &output, maximum)
                    .map_err(|error| {
                        Error::Failed(format!(
                            "Tool completed, but its output could not be saved: {error}"
                        ))
                    })?
            }
            None if output.len() <= maximum && output.lines().count() <= 2000 => output,
            None => {
                return Err(Error::Failed(
                    "tool output exceeds limits and artifact storage is not configured".into(),
                ));
            }
        };
        self.publish(Event::ToolFinished {
            session: session.id.clone(),
            tool: name.into(),
            output: output.clone(),
        })?;
        Ok(ToolResult { output })
    }

    async fn settle_tool(
        &self,
        operation: impl std::future::Future<Output = Result<ToolResult>>,
        session: &Session,
    ) -> Result<ToolResult> {
        match tokio::time::timeout(std::time::Duration::from_secs(5), operation).await {
            Ok(result) => result,
            Err(_) => {
                let cleanup = self.dispose_session(session).await;
                Err(Error::Failed(match cleanup {
                    Ok(()) => "tool did not settle within 5 seconds of cancellation; session resources were disposed".into(),
                    Err(error) => format!("tool did not settle after cancellation; session cleanup failed: {error}"),
                }))
            }
        }
    }

    pub async fn tool(
        &self,
        name: &str,
        args: JsonObject,
        session: &Session,
    ) -> Result<ToolResult> {
        self.execute_tool(self.prepare_tool(name, args, session).await?, session)
            .await
    }

    pub async fn dispose_session(&self, session: &Session) -> Result<()> {
        session.cancellation.cancel();
        let mut errors = Vec::new();
        for entry in self.ready().collect::<Vec<_>>().into_iter().rev() {
            for dispose in entry.registration.session_disposers.iter().rev() {
                let context = Context {
                    session: session.clone(),
                    cancellation: Cancellation::default(),
                    output: None,
                };
                if let Err(error) = bounded_cleanup(async { dispose((), context).await }).await {
                    errors.push(error.to_string());
                }
            }
        }
        if errors.is_empty() {
            return Ok(());
        }
        Err(Error::Failed(errors.join("\n")))
    }
}

async fn forward(
    output: &Sender<String>,
    text: String,
    cancellation: &Cancellation,
    owner: &Cancellation,
) -> Result<()> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::Cancelled),
        () = owner.cancelled() => Err(Error::Cancelled),
        result = output.send(text) => result,
    }
}
