use std::path::Path;

use xal_services::records::Record;
use xal_services::sessions::Loaded;
use xal_services::workflows::{Goal, SuspensionCause};

use super::*;

impl Agent<'_> {
    pub fn redact(&self, text: &str) -> String {
        self.sink.redactor.redact(text)
    }

    pub fn session(&self) -> &Session {
        &self.session
    }
    pub fn journal(&self) -> Option<&Journal> {
        self.sink.journal.as_ref()
    }

    pub fn restore_existing(&mut self, loaded: &Loaded) -> Result<()> {
        if !self.history.is_empty() {
            return Err(failure("cannot replace an active conversation"));
        }
        let recorded = self.snapshot()?;
        if recorded.records[1..] != loaded.records[1..] {
            return Err(failure(
                "journal does not contain the restored conversation",
            ));
        }
        self.history = history::active(&recorded.records)?
            .into_iter()
            .map(|item| redaction::item(self.host, self.sink.redactor, item, &self.session))
            .collect::<Result<_>>()?;
        self.seed_undo(&recorded)?;
        self.restore_workflows(&recorded)?;
        self.summarized = recorded
            .conversation
            .items
            .last()
            .is_some_and(|i| i["type"] == "compaction");
        Ok(())
    }

    pub fn reconcile(&mut self) -> Result<()> {
        let recorded = self.snapshot()?.current;
        let mut events = Vec::new();
        if recorded.provider != self.options.provider
            || recorded.profile != self.options.profile
            || recorded.model != self.options.model
        {
            events.push(AgentEvent::ModelChanged {
                provider: self.options.provider.clone(),
                profile: self.options.profile.clone(),
                model: self.options.model.clone(),
            });
        }
        if recorded.thinking != self.options.thinking {
            events.push(AgentEvent::ThinkingChanged {
                thinking: self.options.thinking.clone(),
            });
        }
        if recorded.mode != self.options.mode {
            events.push(AgentEvent::ModeChanged {
                mode: self.options.mode.clone(),
            });
        }
        if recorded.cwd != self.session.cwd.to_string_lossy() {
            events.push(AgentEvent::WorkspaceChanged {
                cwd: self.session.cwd.to_string_lossy().into_owned(),
                previous: recorded.cwd,
            });
        }
        self.sink.events(&events)
    }

    pub fn title(&mut self, title: &str) -> Result<()> {
        let title = xal_services::sessions::normalize_title(&self.sink.redactor.redact(title))
            .ok_or_else(|| failure("session title must not be empty"))?;
        self.sink.emit(AgentEvent::SessionTitleChanged { title })
    }

    pub fn model(&mut self, options: Options, evaluator: SummaryTarget) -> Result<()> {
        if evaluator.model.trim().is_empty()
            || evaluator.context_window == 0
            || options.model.trim().is_empty()
            || options.provider.trim().is_empty()
            || options.context_window == 0
            || options
                .profile
                .as_ref()
                .is_some_and(|p| p.trim().is_empty())
        {
            return Err(failure("invalid model selection"));
        }
        if options.mode != self.options.mode
            || options.artifacts != self.options.artifacts
            || options.output_schema != self.options.output_schema
        {
            return Err(failure(
                "model selection cannot replace session ownership or permissions",
            ));
        }
        self.sink.events(&[
            AgentEvent::ModelChanged {
                provider: options.provider.clone(),
                profile: options.profile.clone(),
                model: options.model.clone(),
            },
            AgentEvent::ThinkingChanged {
                thinking: options.thinking.clone(),
            },
        ])?;
        self.goals.target = evaluator;
        self.options = options;
        self.context = None;
        self.measured_items = 0;
        self.summarized = false;
        Ok(())
    }

    pub fn prompt_history(&mut self, path: &Path) -> Result<()> {
        self.prompts = Some(
            xal_services::prompt_history::History::load(path, self.sink.redactor)
                .map_err(failure)?,
        );
        Ok(())
    }

    pub fn older_prompt(&mut self, current: &Input) -> Option<Input> {
        self.prompts
            .as_mut()?
            .older(&xal_services::prompt_history::Prompt {
                text: current.text.clone(),
                images: current.images.clone(),
            })
            .map(|p| Input {
                text: p.text,
                images: p.images,
            })
    }

    pub fn newer_prompt(&mut self) -> Option<Input> {
        self.prompts.as_mut()?.newer().map(|p| Input {
            text: p.text,
            images: p.images,
        })
    }

    pub(super) fn restore_workflows(&mut self, loaded: &Loaded) -> Result<()> {
        self.workflows.mode_before_plan = loaded.current.mode_before_plan.clone();
        for recorded in &loaded.events {
            let event = self.sink.redactor.redact_json(recorded);
            match event["type"].as_str() {
                Some("task_list_updated") => {
                    self.workflows.tasks =
                        serde_json::from_value(event["tasks"].clone()).map_err(failure)?
                }
                Some("plan_updated") => {
                    self.workflows.plan = Some(
                        xal_services::workflows::Plan::parse(&event["plan"]).map_err(failure)?,
                    )
                }
                Some("goal_updated") => {
                    self.goals.goal = Some(Goal::parse(&event["goal"]).map_err(failure)?)
                }
                _ => {}
            }
        }
        if let Some(mut goal) = self.goals.goal.clone().filter(Goal::active) {
            goal.started_at = now()?;
            goal.evaluated_turns = 0;
            goal.usage = xal_services::workflows::GoalUsage::default();
            goal.consecutive_no_tool_turns = 0;
            goal.last_reason = None;
            self.goals.usage = Usage::default();
            self.save_goal(goal)?;
        }
        Ok(())
    }

    pub async fn clear(&mut self) -> Result<String> {
        let id = new_id().map_err(failure)?;
        if self.session.jobs.unsettled()? {
            return Err(failure(
                "clear is unavailable while background work is running",
            ));
        }
        self.control.lifetime().check()?;
        let policy = self.host.permission_for(&self.session.id)?;
        let artifacts = self
            .options
            .artifacts
            .parent()
            .ok_or_else(|| failure("session artifacts have no parent"))?
            .join(&id);
        let path = self
            .sink
            .journal
            .as_ref()
            .map(|journal| {
                journal
                    .path()
                    .parent()
                    .map(|parent| parent.join(format!("{id}.jsonl")))
                    .ok_or_else(|| failure("journal has no parent"))
            })
            .transpose()?;
        let mut session = self.host.session(
            id.clone(),
            self.session.cwd.clone(),
            self.session.kind.clone(),
            self.session.read_only,
        )?;
        let mut journal = None;
        let prepared: Result<()> = async {
            if let Some(path) = &path {
                journal = Some(Journal::create(
                    path,
                    &metadata(&session, &self.options, self.sink.redactor)?,
                )?);
            }
            if let Some(policy) = policy {
                self.host.session_permissions(&id, policy)?;
            }
            let old = Session {
                cancellation: self.session.cancellation.child(),
                ..self.session.clone()
            };
            if let Err(error) = self.host.dispose_session(&old).await {
                self.control.lifetime().cancel();
                return Err(error);
            }
            let control = self
                .control
                .reset(session.jobs.clone())
                .and_then(|()| self.control.begin());
            session.cancellation = match control {
                Ok(cancellation) => cancellation,
                Err(error) => {
                    self.control.lifetime().cancel();
                    return Err(error);
                }
            };
            Ok(())
        }
        .await;
        if let Err(error) = prepared {
            let disposed = self.host.dispose_session(&session).await;
            let discarded = journal.map_or(Ok(()), Journal::discard);
            let errors = [disposed.err(), discarded.err()]
                .into_iter()
                .flatten()
                .map(|e| e.to_string())
                .collect::<Vec<_>>();
            return Err(if errors.is_empty() {
                error
            } else {
                failure(format!(
                    "{error}; new session cleanup failed: {}",
                    errors.join("; ")
                ))
            });
        }
        self.sink.journal = journal;
        self.session = session;
        self.options.artifacts = artifacts;
        self.history.clear();
        self.context = None;
        self.measured_items = 0;
        self.summarized = false;
        self.goals.goal = None;
        self.workflows.plan = None;
        self.workflows.tasks.clear();
        self.workflows.dismissed = false;
        self.workflows.restart = false;
        self.background_warned = false;
        self.loops = loops::ToolLoops::default();
        if let Some(contract) = &mut self.contract {
            contract.reset();
        }
        if let Err(error) = self.sink.emit(AgentEvent::SessionStarted {
            id: id.clone(),
            cwd: self.session.cwd.to_string_lossy().into_owned(),
            resumed: false,
            provider: self.options.provider.clone(),
            profile: self.options.profile.clone(),
            model: self.options.model.clone(),
            mode: self.options.mode.clone(),
        }) {
            self.control.lifetime().cancel();
            return Err(error);
        }
        Ok(id)
    }

    pub(super) async fn restart_plan(&mut self) -> Result<()> {
        let plan = self
            .workflows
            .plan
            .clone()
            .ok_or_else(|| failure("approved plan unavailable"))?;
        self.clear().await?;
        self.sink
            .emit(AgentEvent::PlanUpdated { plan: plan.clone() })?;
        self.workflows.plan = Some(plan.clone());
        self.input(Input {
            text: format!("Implement the approved plan below.\n\n{}", plan.markdown),
            images: Vec::new(),
        })
        .await
    }

    pub fn fork(&self, path: &Path) -> Result<Journal> {
        self.sink
            .journal
            .as_ref()
            .ok_or_else(|| failure("session is not recorded"))?
            .fork(path, &new_id().map_err(failure)?, now()?)
    }

    pub fn snapshot(&self) -> Result<Loaded> {
        self.sink
            .journal
            .as_ref()
            .ok_or_else(|| failure("session is not recorded"))?
            .snapshot()
    }

    pub(super) fn seed_undo(&self, loaded: &Loaded) -> Result<()> {
        self.session.undo.lock().map_err(failure)?.seed(
            &self.session.cwd,
            loaded
                .conversation
                .checkpoints
                .iter()
                .map(|p| p.message_id.clone()),
        );
        Ok(())
    }

    pub fn undo(&mut self, message_id: &str) -> Result<()> {
        if self.session.jobs.unsettled()? {
            return Err(failure(
                "undo is unavailable while background work is running",
            ));
        }
        let snapshot = self.snapshot()?;
        let (state, redos) = snapshot.conversation.rewind(message_id).map_err(failure)?;
        let first = redos
            .first()
            .ok_or_else(|| failure("conversation checkpoint unavailable"))?;
        let history = self.replay_items(&state.items)?;
        let shared = self.session.undo.clone();
        shared
            .lock()
            .map_err(failure)?
            .rewind(message_id, redos.len(), |file_count| {
                self.history_transition(AgentEvent::ConversationRewound {
                    message_id: message_id.into(),
                    prompt: first.prompt.clone(),
                    file_count,
                    removed_messages: redos.len(),
                })
            })?;
        self.history = history;
        self.history_moved()
    }

    pub fn redo_workspace(&mut self) -> Result<()> {
        if self.session.jobs.unsettled()? {
            return Err(failure(
                "redo is unavailable while background work is running",
            ));
        }
        let snapshot = self.snapshot()?;
        let redo = snapshot
            .redos
            .last()
            .ok_or_else(|| failure("conversation redo unavailable"))?;
        let history = self.replay_items(&redo.state.items)?;
        let shared = self.session.undo.clone();
        shared
            .lock()
            .map_err(failure)?
            .redo(&redo.message_id, |file_count| {
                self.history_transition(AgentEvent::ConversationRedone {
                    message_id: redo.message_id.clone(),
                    prompt: redo.prompt.clone(),
                    file_count,
                    restored_messages: redo.state.checkpoints.len()
                        - snapshot.conversation.checkpoints.len(),
                })
            })?;
        self.history = history;
        self.history_moved()
    }

    pub fn rewind(&mut self, message_id: &str) -> Result<()> {
        let snapshot = self.snapshot()?;
        let (state, redos) = snapshot.conversation.rewind(message_id).map_err(failure)?;
        let first = redos
            .first()
            .ok_or_else(|| failure("conversation checkpoint unavailable"))?;
        let history = self.replay_items(&state.items)?;
        self.history_transition(AgentEvent::ConversationRewound {
            message_id: message_id.into(),
            prompt: first.prompt.clone(),
            file_count: 0,
            removed_messages: redos.len(),
        })?;
        self.seed_undo(&self.snapshot()?)?;
        self.history = history;
        self.history_moved()
    }

    pub fn redo(&mut self) -> Result<()> {
        let snapshot = self.snapshot()?;
        let redo = snapshot
            .redos
            .last()
            .ok_or_else(|| failure("conversation redo unavailable"))?;
        let history = self.replay_items(&redo.state.items)?;
        self.history_transition(AgentEvent::ConversationRedone {
            message_id: redo.message_id.clone(),
            prompt: redo.prompt.clone(),
            file_count: 0,
            restored_messages: redo.state.checkpoints.len()
                - snapshot.conversation.checkpoints.len(),
        })?;
        self.seed_undo(&self.snapshot()?)?;
        self.history = history;
        self.history_moved()
    }

    fn replay_items(&self, items: &[Value]) -> Result<Vec<Item>> {
        history::from_items(items)?
            .into_iter()
            .map(|item| redaction::item(self.host, self.sink.redactor, item, &self.session))
            .collect()
    }

    fn history_moved(&mut self) -> Result<()> {
        self.context = None;
        self.measured_items = 0;
        self.summarized = false;
        self.loops = loops::ToolLoops::default();
        Ok(())
    }

    fn history_transition(&mut self, movement: AgentEvent) -> Result<()> {
        let mut events = vec![movement];
        let goal = self
            .goals
            .goal
            .clone()
            .filter(Goal::active)
            .map(|mut goal| {
                let mut usage: Usage =
                    serde_json::from_value(json!(goal.usage)).map_err(failure)?;
                usage.add(&self.goals.usage);
                goal.usage = serde_json::from_value(json!(usage)).map_err(failure)?;
                goal.status = xal_services::workflows::GoalStatus::Suspended {
                    suspended_at: now()?,
                    suspension_cause: SuspensionCause::HistoryMovement,
                };
                Goal::parse(&self.sink.redactor.redact_json(&json!(goal))).map_err(failure)
            })
            .transpose()?;
        if let Some(goal) = &goal {
            events.push(AgentEvent::GoalUpdated { goal: goal.clone() });
        }
        self.sink.events(&events)?;
        if let Some(goal) = goal {
            self.goals.goal = Some(goal);
            self.goals.usage = Usage::default();
        }
        Ok(())
    }

    pub async fn direct_shell(
        &mut self,
        input: &str,
        command: &str,
        sandbox: Option<&str>,
    ) -> Result<String> {
        self.session.cancellation = self.control.begin()?;
        let result = self.execute_shell(input, command, sandbox).await;
        let closed = self.control.close().and_then(|pending| {
            if !pending.is_empty() {
                self.sink
                    .emit(AgentEvent::QueueFlushed { inputs: pending })?;
            }
            self.state(AgentState::Idle)
        });
        match (result, closed) {
            (result, Ok(())) => result,
            (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => {
                Err(failure(format!("{error}; shell cleanup failed: {cleanup}")))
            }
        }
    }

    async fn execute_shell(
        &mut self,
        input: &str,
        command: &str,
        sandbox: Option<&str>,
    ) -> Result<String> {
        let call_id = new_id().map_err(failure)?;
        let message_id = new_id().map_err(failure)?;
        let mut args = json!({"command":command});
        if let Some(sandbox) = sandbox {
            args["sandbox"] = json!(sandbox);
        }
        let args = args
            .as_object()
            .cloned()
            .ok_or_else(|| failure("invalid shell arguments"))?;
        let active = self.session.clone();
        let mut effective = command.to_owned();
        let mut read_only = false;
        let previous = self.session.undo.lock().map_err(failure)?.clone();
        self.session
            .undo
            .lock()
            .map_err(failure)?
            .mark(&self.session.cwd, message_id.clone())?;
        let result = async {
            let mut prepared = self.host.prepare_tool("bash", args, &active).await?;
            effective = prepared.args.get("command").and_then(Value::as_str).ok_or_else(|| failure("effective shell command missing"))?.into();
            read_only = prepared.effects == Effects::Read;
            self.approval(&mut prepared, &call_id, &effective, &active).await?;
            self.sink.emit(AgentEvent::ToolStarted { call_id: call_id.clone(), tool: "bash".into(), title: effective.clone(), read_only })?;
            let (sender, mut updates) = channel(16, Cancellation::default())?;
            let operation = self.host.execute_tool_streaming(prepared, &active, Some(sender));
            tokio::pin!(operation);
            let mut result = None;
            let mut closed = false;
            while result.is_none() || !closed {
                tokio::select! {
                    value = &mut operation, if result.is_none() => { result = Some(value); updates.close(); },
                    update = updates.recv(), if !closed => match update {
                        Ok(Some(text)) => {
                            if let Err(error) = self.sink.emit(AgentEvent::ToolUpdated { call_id: call_id.clone(), text }) {
                                active.cancellation.cancel();
                                if result.is_none() { operation.await?; }
                                return Err(error);
                            }
                        }
                        Ok(None) | Err(Error::Cancelled) => closed = true,
                        Err(error) => { active.cancellation.cancel(); if result.is_none() { operation.await?; } return Err(error); }
                    }
                }
            }
            result.ok_or_else(|| failure("shell result missing"))?
        }.await;
        let (output, denial) = match &result {
            Ok(result) => (result.output.clone(), None),
            Err(Error::Denied(reason)) | Err(Error::ApprovalRequired(reason)) => (
                reason.clone(),
                Some(
                    if self.session.read_only {
                        "plan"
                    } else {
                        "policy"
                    }
                    .into(),
                ),
            ),
            Err(error) => (format!("Shell failed: {error}"), None),
        };
        let persistence: Result<(String, Value)> = (|| {
            let output = storage::bound_output(
                &self.options.artifacts,
                &self.sink.redactor.redact(&output),
                20 * 1024,
            )?;
            let event = AgentEvent::ShellFinished {
                message_id: message_id.clone(),
                call_id: call_id.clone(),
                input: input.into(),
                command: effective.clone(),
                output: output.clone(),
                read_only,
                denial: denial.clone(),
            };
            let mut item = json!({"type":"direct_shell","messageId":message_id,"callId":call_id,"input":self.sink.redactor.redact(input),"command":self.sink.redactor.redact(&effective),"output":output,"readOnly":read_only});
            if let Some(denial) = denial {
                item["denial"] = json!(denial);
            }
            Record::parse(&json!({"type":"item","item":item}).to_string()).map_err(failure)?;
            self.sink.paired(event, item.clone())?;
            Ok((output, item))
        })();
        let (output, item) = match persistence {
            Ok(value) => value,
            Err(error) => {
                let mut undo = self.session.undo.lock().map_err(failure)?;
                if let Err(rollback) = undo.rewind(&message_id, 1, |_| Ok(())) {
                    undo.invalidate(
                        "shell persistence failed and its effects could not be rolled back",
                    );
                    return Err(failure(format!(
                        "{error}; shell workspace rollback unavailable: {rollback}"
                    )));
                }
                *undo = previous;
                return Err(error);
            }
        };
        self.history.extend(history::from_items(&[item])?);
        self.refresh_workspace()?;
        match result {
            Ok(_) | Err(Error::Denied(_) | Error::ApprovalRequired(_)) => Ok(output),
            Err(error) => Err(error),
        }
    }
}
