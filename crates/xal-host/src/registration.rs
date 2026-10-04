use std::collections::{BTreeMap, HashSet};
use std::future::Future;

use crate::*;

type CommandHandler = Box<dyn Fn(Vec<String>, Cancellation) -> Call<'static, String> + Send + Sync>;
type Disposer = Box<dyn FnOnce() -> Call<'static, ()> + Send>;

pub(crate) struct Command {
    pub description: String,
    pub run: CommandHandler,
}

pub struct Registration {
    pub(crate) commands: BTreeMap<String, Command>,
    pub(crate) tools: BTreeMap<String, std::sync::Arc<Tool>>,
    pub(crate) snapshots: BTreeMap<String, crate::undo::Scope>,
    pub(crate) tool_sources: BTreeMap<String, ToolSource>,
    pub(crate) prompt_sources: Vec<(String, PromptSource)>,
    pub(crate) providers: BTreeMap<String, Provider>,
    pub(crate) decisions:
        BTreeMap<String, std::sync::Arc<Handler<DecisionRequest, DecisionResponse>>>,
    pub(crate) hooks: Vec<(String, Handler<HookInput, HookResult>)>,
    pub(crate) policies: BTreeMap<String, Handler<PermissionRequest, PolicyDecision>>,
    pub(crate) ui: BTreeMap<String, Handler<UiContribution, String>>,
    pub(crate) warnings: Vec<String>,
    pub(crate) prompts: BTreeMap<String, String>,
    pub(crate) subscriptions: Vec<Sender<Event>>,
    pub(crate) disposers: Vec<Disposer>,
    pub(crate) session_disposers: Vec<Handler<(), ()>>,
    pub(crate) tasks: Vec<tokio::task::JoinHandle<Result<()>>>,
    pub(crate) cancellation: Cancellation,
}

impl Registration {
    pub(crate) fn new(cancellation: Cancellation) -> Self {
        Self {
            commands: BTreeMap::new(),
            tools: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            tool_sources: BTreeMap::new(),
            prompt_sources: Vec::new(),
            providers: BTreeMap::new(),
            decisions: BTreeMap::new(),
            hooks: Vec::new(),
            policies: BTreeMap::new(),
            ui: BTreeMap::new(),
            warnings: Vec::new(),
            prompts: BTreeMap::new(),
            subscriptions: Vec::new(),
            disposers: Vec::new(),
            session_disposers: Vec::new(),
            tasks: Vec::new(),
            cancellation,
        }
    }

    pub fn command(
        &mut self,
        name: &str,
        description: &str,
        run: impl Fn(&[String], &Cancellation) -> Result<String> + Send + Sync + 'static,
    ) -> Result<()> {
        self.command_async(name, description, move |args, cancellation| {
            let result = run(&args, &cancellation);
            Box::pin(async { result })
        })
    }

    pub fn command_async(
        &mut self,
        name: &str,
        description: &str,
        run: impl Fn(Vec<String>, Cancellation) -> Call<'static, String> + Send + Sync + 'static,
    ) -> Result<()> {
        self.cancellation.check()?;
        insert(
            &mut self.commands,
            name,
            Command {
                description: description.into(),
                run: Box::new(run),
            },
        )
    }

    pub fn tool(&mut self, name: &str, tool: Tool) -> Result<()> {
        self.cancellation.check()?;
        xal_services::schema::validator(&serde_json::Value::Object(tool.parameters.clone()))
            .map_err(|error| Error::Failed(error.to_string()))?;
        insert(&mut self.tools, name, std::sync::Arc::new(tool))
    }

    pub fn workspace_snapshots(&mut self, name: &str, scope: crate::undo::Scope) -> Result<()> {
        if !self.tools.contains_key(name) {
            return Err(Error::Failed("snapshot tool is not registered".into()));
        }
        insert(&mut self.snapshots, name, scope)
    }

    pub fn dynamic_tools(&mut self, prefix: &str, source: ToolSource) -> Result<()> {
        self.cancellation.check()?;
        insert(&mut self.tool_sources, prefix, source)
    }

    pub fn prompt_source(&mut self, name: &str, source: PromptSource) -> Result<()> {
        self.cancellation.check()?;
        check_name(
            name,
            self.prompts.contains_key(name)
                || self.prompt_sources.iter().any(|(key, _)| key == name),
        )?;
        self.prompt_sources.push((name.into(), source));
        Ok(())
    }

    pub fn provider(&mut self, name: &str, provider: Provider) -> Result<()> {
        self.cancellation.check()?;
        if provider.models.is_empty() || provider.models.iter().any(String::is_empty) {
            return Err(Error::Failed(
                "provider must declare non-empty model IDs".into(),
            ));
        }
        insert(&mut self.providers, name, provider)
    }

    pub fn decision(
        &mut self,
        name: &str,
        handler: Handler<DecisionRequest, DecisionResponse>,
    ) -> Result<()> {
        self.cancellation.check()?;
        insert(&mut self.decisions, name, std::sync::Arc::new(handler))
    }

    pub fn hook(&mut self, name: &str, handler: Handler<HookInput, HookResult>) -> Result<()> {
        self.cancellation.check()?;
        check_name(name, self.hooks.iter().any(|(key, _)| key == name))?;
        self.hooks.push((name.into(), handler));
        Ok(())
    }

    pub fn policy(
        &mut self,
        name: &str,
        handler: Handler<PermissionRequest, PolicyDecision>,
    ) -> Result<()> {
        self.cancellation.check()?;
        insert(&mut self.policies, name, handler)
    }

    pub fn ui(&mut self, name: &str, handler: Handler<UiContribution, String>) -> Result<()> {
        self.cancellation.check()?;
        insert(&mut self.ui, name, handler)
    }

    pub fn warning(&mut self, message: String) -> Result<()> {
        self.cancellation.check()?;
        self.warnings.push(message);
        Ok(())
    }

    pub fn prompt(&mut self, name: &str, text: String) -> Result<()> {
        self.cancellation.check()?;
        check_name(name, self.prompt_sources.iter().any(|(key, _)| key == name))?;
        insert(&mut self.prompts, name, text)
    }

    pub fn subscribe(&mut self, capacity: usize) -> Result<Receiver<Event>> {
        self.cancellation.check()?;
        let (sender, receiver) = channel(capacity, self.cancellation.clone())?;
        self.subscriptions.push(sender);
        Ok(receiver)
    }

    pub fn spawn(
        &mut self,
        future: impl Future<Output = Result<()>> + Send + 'static,
    ) -> Result<()> {
        self.cancellation.check()?;
        self.tasks.push(tokio::spawn(future));
        Ok(())
    }

    pub fn own(&mut self, disposer: impl FnOnce() -> Result<()> + Send + 'static) {
        self.own_async(move || Box::pin(async { disposer() }));
    }

    pub fn own_async(&mut self, disposer: impl FnOnce() -> Call<'static, ()> + Send + 'static) {
        self.disposers.push(Box::new(disposer));
    }

    pub fn session_disposer(&mut self, handler: Handler<(), ()>) {
        self.session_disposers.push(handler);
    }

    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }

    pub(crate) fn keys(&self) -> Vec<(String, String)> {
        self.commands
            .keys()
            .map(|name| ("command".into(), name.clone()))
            .chain(self.tools.keys().map(|name| ("tool".into(), name.clone())))
            .chain(
                self.tool_sources
                    .keys()
                    .map(|name| ("tool-source".into(), name.clone())),
            )
            .chain(
                self.prompt_sources
                    .iter()
                    .map(|(name, _)| ("prompt".into(), name.clone())),
            )
            .chain(
                self.providers
                    .keys()
                    .map(|name| ("provider".into(), name.clone())),
            )
            .chain(
                self.decisions
                    .keys()
                    .map(|name| ("decision".into(), name.clone())),
            )
            .chain(
                self.hooks
                    .iter()
                    .map(|(name, _)| ("hook".into(), name.clone())),
            )
            .chain(
                self.policies
                    .keys()
                    .map(|name| ("policy".into(), name.clone())),
            )
            .chain(self.ui.keys().map(|name| ("ui".into(), name.clone())))
            .chain(
                self.prompts
                    .keys()
                    .map(|name| ("prompt".into(), name.clone())),
            )
            .collect()
    }

    pub(crate) fn check(&self, registered: &HashSet<(String, String)>) -> Result<()> {
        for key in self.keys() {
            if registered.contains(&key) {
                return Err(Error::Failed(format!("duplicate {}: {}", key.0, key.1)));
            }
        }
        Ok(())
    }

    pub(crate) fn clear(&mut self) {
        self.commands.clear();
        self.tools.clear();
        self.tool_sources.clear();
        self.prompt_sources.clear();
        self.providers.clear();
        self.decisions.clear();
        self.hooks.clear();
        self.policies.clear();
        self.ui.clear();
        self.warnings.clear();
        self.prompts.clear();
        self.subscriptions.clear();
        self.session_disposers.clear();
    }
}

fn insert<T>(registry: &mut BTreeMap<String, T>, name: &str, value: T) -> Result<()> {
    check_name(name, registry.contains_key(name))?;
    registry.insert(name.into(), value);
    Ok(())
}

fn check_name(name: &str, duplicate: bool) -> Result<()> {
    if !valid_name(name) {
        return Err(Error::Failed("invalid capability name".into()));
    }
    if duplicate {
        return Err(Error::Failed(format!("duplicate capability: {name}")));
    }
    Ok(())
}
