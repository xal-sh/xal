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
    pub(crate) concurrency: Concurrency,
    subject: Option<String>,
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

    pub(crate) fn tool_catalog(
        &self,
        session: &Session,
    ) -> Result<std::collections::BTreeMap<String, (&Entry, std::sync::Arc<Tool>)>> {
        let session = self.effective_session(session)?;
        let mut tools = std::collections::BTreeMap::new();
        for entry in self.ready() {
            for (name, tool) in &entry.registration.tools {
                if tools.insert(name.clone(), (entry, tool.clone())).is_some() {
                    return Err(Error::Failed(format!("duplicate tool: {name}")));
                }
            }
            for (prefix, source) in &entry.registration.tool_sources {
                for (name, tool) in guarded(|| source(&session))? {
                    if !valid_name(&name) || !name.starts_with(prefix) {
                        return Err(Error::Failed(format!(
                            "dynamic tool {name} is outside its namespace {prefix}"
                        )));
                    }
                    xal_services::schema::validator(&Value::Object(tool.parameters.clone()))
                        .map_err(|error| Error::Failed(format!("dynamic tool {name}: {error}")))?;
                    if tools.insert(name.clone(), (entry, tool)).is_some() {
                        return Err(Error::Failed(format!("duplicate tool: {name}")));
                    }
                }
            }
        }
        Ok(tools)
    }

    pub fn tools(&self, session: &Session) -> Result<Vec<ToolDefinition>> {
        self.check()?;
        let session = self.effective_session(session)?;
        let session = &session;
        let mut tools = Vec::new();
        for (name, (_, tool)) in self.tool_catalog(session)? {
            if !guarded(|| (tool.available)(session))? {
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

    pub(crate) fn redact_arguments(
        &self,
        name: &str,
        args: &JsonObject,
        redactor: &xal_services::redactor::Redactor,
        session: &Session,
    ) -> Result<JsonObject> {
        if let Some(redact) = self
            .tool_catalog(session)?
            .get(name)
            .and_then(|(_, tool)| tool.redact)
        {
            return guarded(|| redact(args, redactor));
        }
        Ok(args
            .iter()
            .map(|(key, value)| (redactor.redact(key), redactor.redact_json(value)))
            .collect())
    }

    pub async fn prepare_tool(
        &self,
        name: &str,
        args: JsonObject,
        session: &Session,
    ) -> Result<PreparedTool> {
        self.prepare_tool_with(name, args, session, false).await
    }

    async fn prepare_tool_with(
        &self,
        name: &str,
        args: JsonObject,
        session: &Session,
        speculative: bool,
    ) -> Result<PreparedTool> {
        self.check()?;
        session.cancellation.check()?;
        let session = self.effective_session(session)?;
        let session = &session;
        let (_, tool) = self
            .tool_catalog(session)?
            .remove(name)
            .ok_or_else(|| Error::Failed(format!("unknown tool: {name}")))?;
        if !guarded(|| (tool.available)(session))? {
            return Err(Error::Denied(format!(
                "{name} is known but unavailable in this session"
            )));
        }
        let args = if speculative {
            args
        } else {
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
            args
        };
        let args = match tool.redact {
            Some(redact) => guarded(|| redact(&args, &self.output.redactor))?,
            None => self.redact_arguments(name, &args, &self.output.redactor, session)?,
        };
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
            subject: tool
                .permission_subject
                .as_ref()
                .map(|subject| guarded(|| subject(&args)))
                .transpose()?,
            args: args.clone(),
            concurrency: concurrency(&tool, &args, effects)?,
            effects,
        })
    }

    pub async fn authorize_tool(&self, prepared: &PreparedTool, session: &Session) -> Result<()> {
        self.check()?;
        session.cancellation.check()?;
        let session = self.effective_session(session)?;
        let session = &session;
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
            subject: prepared.subject.clone(),
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
        self.execute_tool_with(prepared, session, output, false)
            .await
    }

    async fn execute_tool_with(
        &self,
        prepared: PreparedTool,
        session: &Session,
        output: Option<Sender<String>>,
        speculative: bool,
    ) -> Result<ToolResult> {
        self.check()?;
        self.authorize_tool(&prepared, session).await?;
        session.cancellation.check()?;
        let session = self.effective_session(session)?;
        let session = &session;
        let (entry, tool) = self
            .tool_catalog(session)?
            .remove(&prepared.name)
            .ok_or_else(|| Error::Failed(format!("tool removed: {}", prepared.name)))?;
        if !guarded(|| (tool.available)(session))? {
            return Err(Error::Denied(format!(
                "{} is known but unavailable in this session",
                prepared.name
            )));
        }
        xal_services::schema::validate(
            &Value::Object(tool.parameters.clone()),
            &Value::Object(prepared.args.clone()),
        )
        .map_err(|error| Error::Failed(error.to_string()))?;
        if tool
            .permission_subject
            .as_ref()
            .map(|subject| guarded(|| subject(&prepared.args)))
            .transpose()?
            != prepared.subject
        {
            return Err(Error::Denied(
                "tool permission subject changed after preparation".into(),
            ));
        }
        if guarded(|| Ok((tool.effects)(&prepared.args)))? != prepared.effects
            || concurrency(&tool, &prepared.args, prepared.effects)? != prepared.concurrency
        {
            return Err(Error::Denied(
                "tool effects changed after preparation".into(),
            ));
        }
        let workspace = std::sync::Arc::new(std::sync::Mutex::new(None));
        let cancellation = session.cancellation.child();
        let (sender, mut receiver) = channel(16, Cancellation::default())?;
        let context = Context {
            command_owners: self.command_owners(),
            workspace: (prepared.effects == Effects::Write
                && prepared.concurrency == Concurrency::Exclusive)
                .then(|| workspace.clone()),
            session: session.clone(),
            cancellation: cancellation.clone(),
            output: output.as_ref().map(|_| sender),
            speculative,
            decisions: self.decision_service()?,
            observation: None,
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
        let mut stream_error = None;
        while settled.is_none() || !closed {
            tokio::select! {
                result = &mut supervised, if settled.is_none() => { settled = Some(result); receiver.close(); },
                delta = receiver.recv(), if !closed => {
                    match delta {
                        Ok(Some(delta)) => {
                            let delta = stream.write(&delta);
                            if let Some(output) = &output {
                                let delta = crate::agent::storage::prefix(&delta, (20 * 1024usize).saturating_sub(delivered));
                                delivered += delta.len();
                                if !delta.is_empty()
                                    && let Err(error) = forward(output, delta.into(), &cancellation, &entry.registration.cancellation).await {
                                        cancellation.cancel();
                                        session.cancellation.cancel();
                                        receiver.close();
                                        closed = true;
                                        stream_error = Some(error);
                                    }
                            }
                        }
                        Ok(None) => closed = true,
                        Err(error) => {
                            cancellation.cancel();
                            session.cancellation.cancel();
                            receiver.close();
                            closed = true;
                            stream_error = Some(error);
                        }
                    }
                }
            }
        }
        if stream_error.is_none()
            && let Some(output) = &output
        {
            let tail = stream.end();
            let tail =
                crate::agent::storage::prefix(&tail, (20 * 1024usize).saturating_sub(delivered));
            if !tail.is_empty()
                && let Err(error) = forward(
                    output,
                    tail.into(),
                    &cancellation,
                    &entry.registration.cancellation,
                )
                .await
            {
                cancellation.cancel();
                session.cancellation.cancel();
                stream_error = Some(error);
            }
        }
        let result = settled.ok_or_else(|| Error::Failed("tool result missing".into()))?;
        let changed = self.apply_workspace(session, workspace).await;
        let result = match (result, changed) {
            (result, Ok(())) => result,
            (Ok(_), Err(error)) => return Err(error),
            (Err(error), Err(cleanup)) => {
                return Err(Error::Failed(format!(
                    "{error}; workspace switch failed: {cleanup}"
                )));
            }
        };
        if let Some(error) = stream_error {
            return match result {
                Err(settled) if settled != Error::Cancelled => Err(Error::Failed(format!(
                    "{error}; tool settlement failed: {settled}"
                ))),
                _ => Err(error),
            };
        }
        let result = result?;
        cancellation.check()?;
        cancellation.cancel();
        if speculative {
            return Ok(ToolResult {
                output: self.output.redactor.redact(&result.output),
            });
        }
        self.finish_tool(&prepared.name, result, session).await
    }

    pub(crate) async fn prepare_output(
        &self,
        args: JsonObject,
        session: &Session,
    ) -> Result<PreparedTool> {
        let session = self.effective_session(session)?;
        let session = &session;
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
            concurrency: Concurrency::Shared,
            subject: None,
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

    pub async fn prefetch_file(
        &self,
        path: &std::path::Path,
        session: &Session,
    ) -> Result<Option<String>> {
        self.check()?;
        session.cancellation.check()?;
        let Some(tool) = self
            .ready()
            .find_map(|entry| entry.registration.tools.get("read"))
        else {
            return Ok(None);
        };
        if !guarded(|| (tool.available)(session))? {
            return Ok(None);
        }
        let args = JsonObject::from_iter([(
            "file_path".into(),
            Value::String(path.to_string_lossy().into_owned()),
        )]);
        let prepared = self.prepare_tool_with("read", args, session, true).await?;
        if prepared.effects != Effects::Read {
            return Ok(None);
        }
        match self.authorize_tool(&prepared, session).await {
            Err(Error::Denied(_) | Error::ApprovalRequired(_)) => return Ok(None),
            result => result?,
        }
        match self.execute_tool_with(prepared, session, None, true).await {
            Ok(result) => Ok(Some(result.output)),
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(_) if session.cancellation.check().is_err() => Err(Error::Cancelled),
            Err(_) => Ok(None),
        }
    }

    pub async fn dispose_session(&self, session: &Session) -> Result<()> {
        session.cancellation.cancel();
        let session = self.effective_session(session)?;
        let result = self.dispose_resources(&session).await;
        self.workspaces
            .lock()
            .map_err(|_| Error::Failed("workspace state lock poisoned".into()))?
            .remove(&session.id);
        result
    }

    pub(crate) async fn dispose_resources(&self, session: &Session) -> Result<()> {
        let mut errors = Vec::new();
        for entry in self.ready().collect::<Vec<_>>().into_iter().rev() {
            for dispose in entry.registration.session_disposers.iter().rev() {
                let context = Context {
                    command_owners: self.command_owners(),
                    workspace: None,
                    session: session.clone(),
                    cancellation: Cancellation::default(),
                    output: None,
                    speculative: false,
                    decisions: None,
                    observation: None,
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

fn concurrency(tool: &Tool, args: &JsonObject, effects: Effects) -> Result<Concurrency> {
    guarded(|| {
        Ok(match tool.concurrency {
            Some(concurrency) => concurrency(args),
            None => match effects {
                Effects::Read => Concurrency::Shared,
                Effects::Write => Concurrency::Exclusive,
            },
        })
    })
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
