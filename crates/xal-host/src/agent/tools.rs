use futures_util::stream::{FuturesUnordered, StreamExt};
use xal_services::redactor::Redactor;

use super::{Agent, AgentEvent, AgentState, loops, storage, stream};
use crate::*;

struct Call {
    id: String,
    name: String,
    args: JsonObject,
    prepared: Result<PreparedTool>,
}

impl Call {
    fn read_only(&self) -> bool {
        self.prepared
            .as_ref()
            .is_ok_and(|tool| tool.effects == Effects::Read)
    }
    fn title(&self) -> String {
        self.args
            .get("file_path")
            .or_else(|| self.args.get("command"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&self.name)
            .into()
    }
}

impl Agent<'_> {
    pub(super) async fn tools(&mut self, calls: Vec<Item>, active: &Session) -> Result<()> {
        let start = self.history.len();
        let result = self.execute_calls(calls.clone(), active).await;
        if let Err(error) = &result {
            for call in calls {
                let Item::ToolCall { call_id, .. } = &call else {
                    return Err(Error::Failed("expected tool call".into()));
                };
                if self.history[start..].iter().any(
                    |item| matches!(item, Item::ToolResult { call_id: id, .. } if id == call_id),
                ) {
                    continue;
                }
                if let Err(cleanup) =
                    self.skipped(call, &format!("Tool was not completed: {error}"))
                {
                    return Err(Error::Failed(format!(
                        "{error}\nCould not finalize pending tool calls: {cleanup}"
                    )));
                }
            }
        }
        result
    }

    async fn execute_calls(&mut self, calls: Vec<Item>, active: &Session) -> Result<()> {
        let mut shared = Vec::new();
        let mut stopped: Option<String> = None;
        for item in calls {
            if let Some(reason) = &stopped {
                self.skipped(item, reason)?;
                continue;
            }
            if active.cancellation.check().is_err() {
                self.skipped(item, "Tool was interrupted before execution.")?;
                continue;
            }
            let Item::ToolCall {
                call_id,
                name,
                args,
                ..
            } = item
            else {
                return Err(Error::Failed("expected tool call".into()));
            };
            if name == "submit_output" && self.contract.is_some() {
                self.batch(std::mem::take(&mut shared), active).await?;
                active.cancellation.check()?;
                let prepared = self.host.prepare_output(args, active).await?;
                self.update_call(&call_id, &name, &prepared.args)?;
                let result = self.host.authorize_tool(&prepared, active).await;
                let (output, denial) = match result {
                    Ok(()) => {
                        self.sink.emit(AgentEvent::ToolStarted {
                            call_id: call_id.clone(),
                            tool: name.clone(),
                            title: "Submit structured output".into(),
                            read_only: true,
                        })?;
                        let contract = self
                            .contract
                            .as_mut()
                            .ok_or_else(|| Error::Failed("output contract missing".into()))?;
                        let output = contract
                            .submit(Some(serde_json::Value::Object(prepared.args).to_string()))
                            .map_err(super::failure)?;
                        if contract.output().is_some() || contract.exhausted() {
                            stopped = Some(
                                "Tool was skipped because structured output is settled."
                                    .to_string(),
                            );
                        }
                        (
                            self.host
                                .finish_tool(&name, ToolResult { output }, active)
                                .await?
                                .output,
                            None,
                        )
                    }
                    Err(Error::ApprovalRequired(_)) => {
                        self.sink.emit(AgentEvent::ApprovalRequested {
                            call_id: call_id.clone(),
                            tool: name.clone(),
                            title: "Submit structured output".into(),
                            read_only: true,
                        })?;
                        return Err(Error::Denied("This action needed approval but the session is headless, so it was not run.".into()));
                    }
                    Err(error) => return Err(error),
                };
                self.finish(
                    &call_id,
                    &name,
                    "Submit structured output",
                    true,
                    output,
                    denial,
                )?;
                continue;
            }
            let prepared = self.host.prepare_tool(&name, args.clone(), active).await;
            let effective = prepared
                .as_ref()
                .map_or(args, |prepared| prepared.args.clone());
            self.update_call(&call_id, &name, &effective)?;
            let mut call = Call {
                id: call_id,
                name,
                args: effective,
                prepared,
            };
            match self.loops.inspect(&call.name, &call.args) {
                loops::Action::Allow => {},
                loops::Action::Steer => call.prepared = Err(Error::Failed("Tool loop detected: the same call returned the same result twice. Use a different approach or return the result; do not repeat this call.".into())),
                loops::Action::Stop => {
                    call.prepared = Err(Error::Failed("repeated tool loop after steering".into()));
                    stopped = Some("Tool was skipped because a repeated tool loop was detected.".into());
                }
            }
            if call.read_only() && stopped.is_none() {
                shared.push(call);
                if shared.len() == 4 {
                    self.batch(std::mem::take(&mut shared), active).await?;
                }
                continue;
            }
            self.batch(std::mem::take(&mut shared), active).await?;
            self.batch(vec![call], active).await?;
        }
        self.batch(shared, active).await?;
        active.cancellation.check()?;
        if stopped
            .as_ref()
            .is_some_and(|reason| reason.contains("repeated tool loop"))
        {
            return Err(Error::Failed("repeated tool loop after steering".into()));
        }
        Ok(())
    }

    async fn batch(&mut self, calls: Vec<Call>, active: &Session) -> Result<()> {
        if calls.is_empty() {
            return Ok(());
        }
        let mut running = FuturesUnordered::new();
        let (updates, mut receiver) = channel(32, Cancellation::default())?;
        let mut results = Vec::new();
        let mut failure = None;
        let mut sources = Vec::new();
        let mut finished = Vec::new();
        for (index, call) in calls.into_iter().enumerate() {
            let title = call.title();
            let read_only = call.read_only();
            let prepared = match call.prepared {
                Ok(prepared) => match self.host.authorize_tool(&prepared, active).await {
                    Ok(()) => Ok(prepared),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            if matches!(prepared, Err(Error::ApprovalRequired(_))) {
                self.state(AgentState::AwaitingApproval)?;
                self.sink.emit(AgentEvent::ApprovalRequested {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    title: title.clone(),
                    read_only,
                })?;
                self.state(AgentState::RunningTool)?;
            }
            if prepared.is_ok() {
                self.sink.emit(AgentEvent::ToolStarted {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    title: title.clone(),
                    read_only,
                })?;
            }
            let host = self.host;
            let redactor = self.sink.redactor;
            let updates = updates.clone();
            running.push(async move {
                let result = match prepared {
                    Ok(prepared) => {
                        execute(host, prepared, active, &call.id, redactor, updates).await
                    }
                    Err(error) => Err(error),
                };
                (
                    index, call.id, call.name, call.args, title, read_only, result,
                )
            });
        }
        drop(updates);
        let observed: Result<()> = async {
            let mut closed = false;
            while !running.is_empty() || !closed {
                tokio::select! {
                    update = receiver.recv(), if !closed => match update? {
                        Some(event) => self.sink.emit(event)?,
                        None => closed = true,
                    },
                    result = running.next(), if !running.is_empty() => {
                        let Some((index, id, name, args, title, read_only, result)) = result else { continue; };
                        while let Some(event) = receiver.try_recv()? { self.sink.emit(event)?; }
                        let succeeded = result.is_ok();
                        let (output, denial) = match result {
                            Ok(result) => (result.output, None),
                            Err(Error::ApprovalRequired(_)) => ("This action needed approval but the session is headless, so it was not run.".into(), Some("policy".into())),
                            Err(Error::Denied(reason)) => (reason, Some(if self.session.read_only { "plan" } else { "policy" }.into())),
                            Err(Error::Cancelled) => ("Tool was interrupted.".into(), None),
                            Err(error) => {
                                if active.cancellation.check().is_err() { failure = Some(error.clone()); }
                                (format!("Tool failed: {error}"), None)
                            },
                        };
                        let output = self.sink.redactor.redact(&output);
                        self.loops.record(&name, &args, &output);
                        let output = storage::bound_output(&self.options.artifacts, &output, if name == "bash" { 20 * 1024 } else { 50 * 1024 })
                            .map_err(|error| Error::Failed(format!("Tool completed, but its output could not be saved: {error}")))?;
                        let bounded = output.lines().any(|line| line.starts_with("... output truncated (") && line.ends_with(" bytes) ..."))
                            && output.lines().last().is_some_and(|line| line.starts_with("Full output saved to: "));
                        if succeeded && ["read", "grep", "glob"].contains(&name.as_str()) && !bounded && !output.starts_with("Tool failed: ") && !output.starts_with("Tool completed, but its output could not be saved: ") { sources.push((index, id.clone(), name.clone(), args, output.clone())); }
                        finished.push((index, AgentEvent::ToolFinished { call_id: id.clone(), tool: name, title, read_only, output: output.clone(), denial }));
                        results.push((index, Item::ToolResult { call_id: id, output }));
                    }
                    () = self.control.changed.notified() => stream::queue_changed(&self.control, &mut self.sink)?,
                }
            }
            Ok(())
        }.await;
        if observed.is_err() {
            active.cancellation.cancel();
            drop(receiver);
            while running.next().await.is_some() {}
        }
        observed?;
        sources.sort_by_key(|(index, ..)| *index);
        if let Some((_, target, ..)) = sources.last() {
            let target = target.clone();
            let trigger = super::read_ahead::Trigger::Tools(
                sources
                    .into_iter()
                    .map(|(_, _, name, args, output)| (name, args, output))
                    .collect(),
            );
            if let Some(text) = self.read_ahead(trigger, active).await? {
                for (_, item) in &mut results {
                    if let Item::ToolResult { call_id, output } = item
                        && *call_id == target
                    {
                        output.push_str(&format!("\n\n{text}"));
                    }
                }
                for (_, event) in &mut finished {
                    if let AgentEvent::ToolFinished {
                        call_id, output, ..
                    } = event
                        && *call_id == target
                    {
                        output.push_str(&format!("\n\n{text}"));
                    }
                }
            }
        }
        for (_, event) in finished {
            self.sink.emit(event)?;
        }
        results.sort_by_key(|(index, _)| *index);
        for (_, item) in results {
            self.push(item)?;
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn update_call(&mut self, id: &str, name: &str, effective: &JsonObject) -> Result<()> {
        for item in self.history.iter_mut().rev() {
            if let Item::ToolCall {
                call_id,
                args,
                replay,
                ..
            } = item
                && call_id == id
            {
                if args != effective {
                    *args = effective.clone();
                    *replay = None;
                }
                break;
            }
        }
        self.sink.emit(AgentEvent::ToolCallUpdated {
            call_id: id.into(),
            tool: name.into(),
            args: effective.clone(),
        })
    }

    fn finish(
        &mut self,
        id: &str,
        name: &str,
        title: &str,
        read_only: bool,
        output: String,
        denial: Option<String>,
    ) -> Result<()> {
        self.sink.emit(AgentEvent::ToolFinished {
            call_id: id.into(),
            tool: name.into(),
            title: title.into(),
            read_only,
            output: output.clone(),
            denial,
        })?;
        self.push(Item::ToolResult {
            call_id: id.into(),
            output,
        })
    }

    pub(super) fn skipped(&mut self, call: Item, reason: &str) -> Result<()> {
        let Item::ToolCall { call_id, name, .. } = call else {
            return Err(Error::Failed("expected skipped tool call".into()));
        };
        self.finish(&call_id, &name, &name, false, reason.into(), None)
    }
}

async fn execute(
    host: &Host,
    prepared: PreparedTool,
    active: &Session,
    id: &str,
    redactor: &Redactor,
    updates: Sender<AgentEvent>,
) -> Result<ToolResult> {
    let (sender, mut receiver) = channel(16, Cancellation::default())?;
    let operation = host.execute_tool_streaming(prepared, active, Some(sender));
    tokio::pin!(operation);
    let mut stream = redactor.stream();
    let mut delivered = 0;
    let mut closed = false;
    let mut result = None;
    while result.is_none() || !closed {
        tokio::select! {
            value = &mut operation, if result.is_none() => { result = Some(value); receiver.close(); },
            update = receiver.recv(), if !closed => match update {
                Ok(Some(delta)) => {
                    let delta = stream.write(&delta);
                    let text = storage::prefix(&delta, 20 * 1024 - delivered);
                    if !text.is_empty() {
                        delivered += text.len();
                        if let Err(error) = updates.send(AgentEvent::ToolUpdated { call_id: id.into(), text: text.into() }).await {
                            active.cancellation.cancel();
                            let settled = match result { Some(result) => result, None => operation.await };
                            return match settled { Err(error) if error != Error::Cancelled => Err(error), _ => Err(error) };
                        }
                    }
                }
                Ok(None) | Err(Error::Cancelled) => closed = true,
                Err(error) => { active.cancellation.cancel(); if result.is_none() { operation.await?; } return Err(error); }
            }
        }
    }
    let tail = stream.end();
    let text = storage::prefix(&tail, 20 * 1024 - delivered);
    if !text.is_empty() {
        updates
            .send(AgentEvent::ToolUpdated {
                call_id: id.into(),
                text: text.into(),
            })
            .await?;
    }
    result.ok_or_else(|| Error::Failed("tool result missing".into()))?
}
