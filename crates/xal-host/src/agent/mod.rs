mod background;
pub(crate) mod context;
mod control;
mod events;
mod goals;
pub mod history;
mod intelligence;
mod jev;
mod loops;
mod read_ahead;
mod redaction;
mod session;
mod sink;
pub(crate) mod storage;
mod stream;
mod tools;
mod workflows;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use xal_services::credentials::new_id;
use xal_services::output_contract::OutputContract;
use xal_services::redactor::Redactor;

pub use control::Control;
pub use events::*;
pub use storage::Journal;

use crate::*;
use sink::{Sink, failure};

#[derive(Clone)]
pub struct SummaryTarget {
    pub model: String,
    pub thinking: Option<String>,
    pub image_input: bool,
    pub context_window: u64,
}

#[derive(Clone)]
pub struct Options {
    pub provider: String,
    pub profile: Option<String>,
    pub model: String,
    pub mode: String,
    pub instructions: String,
    pub thinking: Option<String>,
    pub context_window: u64,
    pub image_input: bool,
    pub summary_target: Option<SummaryTarget>,
    pub compaction_limit: Option<u64>,
    pub output_schema: Option<JsonObject>,
    pub artifacts: PathBuf,
}

pub struct Agent<'a> {
    host: &'a Host,
    session: Session,
    options: Options,
    control: Control,
    sink: Sink<'a>,
    history: Vec<Item>,
    contract: Option<OutputContract>,
    usage: Option<Usage>,
    cycle_usage: Option<Usage>,
    cycle_settled: bool,
    context: Option<Usage>,
    measured_items: usize,
    summarized: bool,
    loops: loops::ToolLoops,
    workflows: workflows::Workflows,
    goals: goals::Goals,
    background_warned: bool,
    defer_interactions: bool,
    prompts: Option<xal_services::prompt_history::History>,
}

impl<'a> Agent<'a> {
    pub fn new(
        host: &'a Host,
        session: Session,
        mut options: Options,
        redactor: &'a Redactor,
        journal: Option<Journal>,
        receive: &'a mut dyn FnMut(AgentEvent) -> Result<()>,
    ) -> Result<Self> {
        if options.context_window == 0 {
            return Err(Error::Failed("context window must be positive".into()));
        }
        options.output_schema = options
            .output_schema
            .map(|schema| redaction::object(redactor, &schema));
        let contract = options
            .output_schema
            .as_ref()
            .map(|schema| {
                OutputContract::new(Value::Object(schema.clone()).to_string()).map_err(failure)
            })
            .transpose()?;
        host.session_options
            .lock()
            .map_err(failure)?
            .insert(session.id.clone(), options.clone());
        Ok(Self {
            host,
            control: Control::new(session.cancellation.clone(), session.jobs.clone()),
            session,
            prompts: None,
            background_warned: false,
            defer_interactions: false,
            workflows: workflows::Workflows::default(),
            goals: goals::Goals {
                goal: None,
                target: SummaryTarget {
                    model: options.model.clone(),
                    thinking: None,
                    image_input: options.image_input,
                    context_window: options.context_window,
                },
                tools: false,
                usage: Usage::default(),
            },
            options,
            sink: Sink {
                host,
                redactor,
                journal,
                receive,
                response: String::new(),
            },
            history: Vec::new(),
            contract,
            usage: None,
            cycle_usage: None,
            cycle_settled: false,
            context: None,
            measured_items: 0,
            summarized: false,
            loops: loops::ToolLoops::default(),
        })
    }

    pub fn control(&self) -> Control {
        self.control.clone()
    }

    pub fn history(&self) -> &[Item] {
        &self.history
    }

    pub fn restore(&mut self, records: &[xal_services::records::Record]) -> Result<()> {
        if !self.history.is_empty() {
            return Err(failure("cannot replace an active conversation"));
        }
        let items = history::active(records)?;
        if records
            .first()
            .is_some_and(|r| r.kind() == xal_services::records::RecordKind::Meta)
        {
            let loaded = xal_services::sessions::replay(records).map_err(failure)?;
            self.seed_undo(&loaded)?;
            if let Some(journal) = &mut self.sink.journal {
                journal.copy_history(records)?;
            }
            self.restore_workflows(&loaded)?;
            self.history = items
                .into_iter()
                .map(|item| redaction::item(self.host, self.sink.redactor, item, &self.session))
                .collect::<Result<_>>()?;
            self.summarized = records
                .iter()
                .rev()
                .find(|r| r.kind() == xal_services::records::RecordKind::Item)
                .is_some_and(|r| r.payload()["item"]["type"] == "compaction");
            return Ok(());
        }
        let checkpoint = records
            .iter()
            .rev()
            .find(|r| r.kind() == xal_services::records::RecordKind::Item)
            .filter(|r| {
                r.payload()["item"]["type"] == "compaction"
                    && r.payload()["item"]["strategy"] == "user_messages_v1"
            });
        if let Some(checkpoint) = checkpoint {
            let items = items
                .into_iter()
                .map(|item| redaction::item(self.host, self.sink.redactor, item, &self.session))
                .collect::<Result<Vec<_>>>()?;
            let mut checkpoint = checkpoint.payload()["item"].clone();
            checkpoint["retained"] = json!(&items[..items.len() - 1]);
            checkpoint["summary"] = self.sink.redactor.redact_json(&checkpoint["summary"]);
            if let Some(journal) = &mut self.sink.journal {
                journal.append(&json!({"type":"item","item":checkpoint}))?;
            }
            self.history = items;
            self.summarized = true;
            return Ok(());
        }
        for item in items {
            if let Item::UserMessage {
                message_id: Some(id),
                text,
                images,
                ..
            } = &item
            {
                self.sink.emit(AgentEvent::UserMessage {
                    message_id: id.clone(),
                    text: text.clone(),
                    image_count: images.len().try_into().map_err(failure)?,
                    sent_at: 0,
                })?;
            }
            self.push(item)?;
        }
        Ok(())
    }

    pub async fn run(&mut self, input: Input) -> Result<Outcome> {
        let result = self.run_turn(input).await;
        let cleanup = self.close().await;
        match (result, cleanup) {
            (result, Ok(())) => result,
            (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(failure(format!(
                "{error}; session cleanup failed: {cleanup}"
            ))),
        }
    }

    pub async fn close(&mut self) -> Result<()> {
        self.control.lifetime().cancel();
        self.control.close()?;
        self.host.dispose_session(&self.session).await
    }

    pub fn defer_interactions(&mut self, defer: bool) {
        self.defer_interactions = defer;
    }

    pub async fn continue_turn(&mut self, retry_pending: bool) -> Result<Outcome> {
        self.drive(None, retry_pending).await
    }

    pub async fn run_turn(&mut self, input: Input) -> Result<Outcome> {
        self.drive(Some(input), false).await
    }

    async fn drive(&mut self, input: Option<Input>, retry_pending: bool) -> Result<Outcome> {
        self.session.cancellation = self.control.begin()?;
        self.usage = None;
        self.cycle_usage = None;
        self.cycle_settled = false;
        self.background_warned = false;
        self.workflows.dismissed = false;
        self.goals.tools = false;
        self.goals.usage = Usage::default();
        self.sink.response.clear();
        self.loops = loops::ToolLoops::default();
        if let Some(contract) = &mut self.contract {
            contract.reset();
        }
        if input.is_some() {
            self.rearm_goal()?;
        }
        let result = self.turn(input, retry_pending).await;
        if let Err(error) = &result
            && !matches!(error, Error::Paused | Error::NeedsInput)
        {
            self.suspend_goal(if *error == Error::Cancelled {
                xal_services::workflows::SuspensionCause::Interruption
            } else {
                xal_services::workflows::SuspensionCause::TurnFailure
            })?;
        }
        let closed = self.control.close().and_then(|pending| {
            if !pending.is_empty() {
                self.sink
                    .emit(AgentEvent::QueueFlushed { inputs: pending })?;
            }
            Ok(())
        });
        let result = result.and(closed);
        let response = match self.contract.as_ref().and_then(OutputContract::output) {
            Some(value) => self
                .sink
                .redactor
                .redact_json(&serde_json::from_str(&value).map_err(failure)?),
            None => Value::String(self.sink.response.clone()),
        };
        if result.is_err()
            && let Some(recorder) = &self.host.recorder
        {
            recorder.turn(&self.session, &result, self.context.as_ref())?;
        }
        let outcome = match result {
            Err(Error::Paused) => Outcome::Paused { response },
            Err(Error::NeedsInput) => Outcome::NeedsInput { response },
            Ok(()) => Outcome::Completed {
                response,
                usage: self.usage.clone(),
                context: self.context.clone(),
            },
            Err(Error::Cancelled) => {
                self.sink.emit(AgentEvent::TurnInterrupted)?;
                Outcome::Interrupted { response }
            }
            Err(error) => {
                let message = self.sink.redactor.redact(&error.to_string());
                self.sink.emit(AgentEvent::TurnFailed {
                    message: message.clone(),
                    usage: self.usage.clone(),
                    context: self.context.clone(),
                })?;
                Outcome::Failed {
                    response,
                    error: message,
                    usage: self.usage.clone(),
                    context: self.context.clone(),
                }
            }
        };
        self.state(AgentState::Idle)?;
        Ok(outcome)
    }

    fn pending_calls(&self) -> Vec<Item> {
        history::pending_calls(&self.history)
    }

    pub fn flush_recording(&self) -> Result<()> {
        self.host
            .recorder
            .as_ref()
            .map_or(Ok(()), |recorder| recorder.flush())
    }

    pub async fn handoff(&mut self) -> Result<Journal> {
        let jobs = self.session.jobs.list()?;
        let mut stopped = Vec::new();
        for job in jobs {
            if !job.done()? {
                stopped.push(job.id.clone());
            }
        }
        self.session.jobs.shutdown().await?;
        if !stopped.is_empty() {
            self.push(Item::user(format!("This session moved to a different process. Background jobs cannot move and were stopped before handoff: {}", stopped.join(", "))))?;
        }
        self.close().await?;
        self.sink
            .journal
            .take()
            .ok_or_else(|| failure("only recorded sessions can be handed off"))
    }

    fn refresh_workspace(&mut self) -> Result<()> {
        let session = self.host.effective_session(&self.session)?;
        if session.cwd == self.session.cwd {
            return Ok(());
        }
        let previous = self.session.cwd.to_string_lossy().into_owned();
        self.session = session;
        self.loops = loops::ToolLoops::default();
        self.sink.emit(AgentEvent::WorkspaceChanged {
            cwd: self.session.cwd.to_string_lossy().into_owned(),
            previous,
        })
    }

    async fn turn(&mut self, input: Option<Input>, retry_pending: bool) -> Result<()> {
        self.sink.emit(AgentEvent::SessionStarted {
            id: self.session.id.clone(),
            cwd: self.session.cwd.to_string_lossy().into_owned(),
            resumed: !self.history.is_empty(),
            provider: self.options.provider.clone(),
            profile: self.options.profile.clone(),
            model: self.options.model.clone(),
            mode: self.options.mode.clone(),
        })?;
        let pending = self.pending_calls();
        if retry_pending {
            self.tools(pending, &self.session.clone()).await?;
            if self.workflows.dismissed {
                return self.complete_cycle().await;
            }
            if self.workflows.restart {
                self.restart_plan().await?;
            }
        } else {
            for call in pending {
                self.skipped(call, "The previous process stopped before recording a result. Do not assume success or repeat its effects; inspect the workspace first.")?;
            }
        }
        if let Some(input) = input {
            self.input(input).await?;
        }
        let mut interjected = false;
        loop {
            self.refresh_workspace()?;
            self.session.cancellation.check()?;
            self.control.boundary()?;
            self.host
                .session_options
                .lock()
                .map_err(failure)?
                .insert(self.session.id.clone(), self.options.clone());
            self.background_results()?;
            self.parent_questions()?;
            let queued = self.control.drain()?;
            if !queued.is_empty() {
                self.sink.emit(AgentEvent::QueueChanged {
                    entries: Vec::new(),
                })?;
                for input in queued {
                    self.input(input).await?;
                }
                self.loops = loops::ToolLoops::default();
                interjected = true;
                if let Some(contract) = &mut self.contract {
                    contract.reset();
                }
            }
            let active = Session {
                cancellation: self.session.cancellation.child(),
                ..self.session.clone()
            };
            self.control.active(active.cancellation.clone())?;
            let request = match self.admit(&active).await {
                Err(Error::Cancelled) if self.control.steered()? => continue,
                result => result?,
            };
            self.cycle_settled = false;
            self.state(AgentState::Streaming)?;
            let round = stream::run(
                self.host,
                &self.options.provider,
                request,
                &active,
                &self.control,
                &mut self.sink,
                stream::Mode::Turn,
            )
            .await?;
            let calls = round
                .items
                .iter()
                .filter(|item| matches!(item, Item::ToolCall { .. }))
                .cloned()
                .collect::<Vec<_>>();
            for item in round.items {
                self.push(item)?;
            }
            if let Some(usage) = round.usage {
                self.usage.get_or_insert_default().add(&usage);
                self.cycle_usage.get_or_insert_default().add(&usage);
                if self
                    .goals
                    .goal
                    .as_ref()
                    .is_some_and(xal_services::workflows::Goal::active)
                {
                    self.goals.usage.add(&usage);
                }
                self.context = Some(usage.clone());
                self.measured_items = self.history.len();
                self.sink
                    .emit(AgentEvent::ContextUpdated { context: usage })?;
            }
            if let Err(error) = round.result {
                for call in calls {
                    self.skipped(
                        call,
                        "Tool was not run because the provider round did not complete.",
                    )?;
                }
                if error == Error::Cancelled && self.control.steered()? {
                    continue;
                }
                return Err(error);
            }
            self.control.boundary()?;
            if !calls.is_empty() {
                self.goals.tools = true;
                interjected = false;
                self.state(AgentState::RunningTool)?;
                let result = self.tools(calls, &active).await;
                if result == Err(Error::Cancelled) && self.control.steered()? {
                    continue;
                }
                result?;
                if self.workflows.dismissed {
                    break;
                }
                if self.workflows.restart {
                    self.restart_plan().await?;
                    continue;
                }
                if let Some(contract) = &self.contract {
                    if contract.exhausted() {
                        return Err(Error::Failed(contract.failure()));
                    }
                    if contract.output().is_some() {
                        if self.background_boundary().await? {
                            continue;
                        }
                        self.complete_cycle().await?;
                        if self.goal_boundary().await? {
                            continue;
                        }
                        if self.control.finish_if_empty()? {
                            break;
                        }
                    }
                }
                continue;
            }
            if !self.control.pending()?.is_empty() {
                continue;
            }
            if interjected {
                interjected = false;
                self.push(Item::user("The queued user request has been answered. Resume the interrupted work, unless the user changed or cancelled it.".into()))?;
                continue;
            }
            if let Some(contract) = &mut self.contract {
                let correction = contract.missing();
                if contract.exhausted() {
                    return Err(Error::Failed(contract.failure()));
                }
                self.push(Item::user(correction))?;
                continue;
            }
            if let Some(task) = self.session.task.clone() {
                self.complete_cycle().await?;
                let notice = task.cycle()?;
                if task.limit_reached()? {
                    self.session.jobs.shutdown().await?;
                    break;
                }
                if let Some(notice) = notice {
                    self.push(Item::user(notice))?;
                }
            }
            if self.background_boundary().await? {
                continue;
            }
            self.complete_cycle().await?;
            if self.goal_boundary().await? {
                continue;
            }
            if self.control.finish_if_empty()? {
                break;
            }
        }
        self.complete_cycle().await
    }

    async fn complete_cycle(&mut self) -> Result<()> {
        if self.cycle_settled {
            return Ok(());
        }
        self.state(AgentState::RunningHook)?;
        self.host.hook(HookInput::TurnEnd, &self.session).await?;
        self.session.cancellation.check()?;
        if let Some(recorder) = &self.host.recorder {
            recorder.turn(&self.session, &Ok(()), self.context.as_ref())?;
        }
        self.sink.emit(AgentEvent::TurnEnded {
            usage: self.cycle_usage.clone(),
            context: self.context.clone(),
            output: self
                .contract
                .as_ref()
                .and_then(OutputContract::output)
                .map(|value| serde_json::from_str(&value).map_err(failure))
                .transpose()?,
        })?;
        self.cycle_usage = None;
        self.cycle_settled = true;
        Ok(())
    }

    async fn input(&mut self, input: Input) -> Result<()> {
        if !input.images.is_empty() && !self.options.image_input {
            return Err(failure("selected model does not support image input"));
        }
        xal_services::records::Record::parse(&json!({"type":"item","item":{"type":"user_message","text":input.text,"images":input.images}}).to_string()).map_err(failure)?;
        self.state(AgentState::RunningHook)?;
        let HookInput::Prompt { mut text } = self
            .host
            .hook(
                HookInput::Prompt {
                    text: input.text.clone(),
                },
                &self.session,
            )
            .await?
        else {
            return Err(Error::Failed("invalid prompt hook result".into()));
        };
        if let Some(prefetched) = self
            .read_ahead(
                read_ahead::Trigger::Prompt(text.clone()),
                &self.session.clone(),
            )
            .await?
        {
            text = format!("{text}\n\n{prefetched}");
        }
        let message_id = new_id().map_err(failure)?;
        if let Some(prompts) = &mut self.prompts {
            prompts
                .record(&input.text, self.sink.redactor)
                .map_err(failure)?;
        }
        let event = AgentEvent::UserMessage {
            message_id: message_id.clone(),
            text: input.text.clone(),
            image_count: input.images.len().try_into().map_err(failure)?,
            sent_at: now()?,
        };
        let item = redaction::item(
            self.host,
            self.sink.redactor,
            Item::UserMessage {
                model_text: (text != input.text).then_some(text),
                text: input.text,
                message_id: Some(message_id),
                images: input.images,
            },
            &self.session,
        )?;
        let shared = self.session.undo.clone();
        let persist = || {
            self.sink
                .paired(event, serde_json::to_value(&item).map_err(failure)?)
        };
        if self.session.task.is_none() {
            let Item::UserMessage {
                message_id: Some(id),
                ..
            } = &item
            else {
                return Err(failure("authored input lost its identity"));
            };
            shared
                .lock()
                .map_err(failure)?
                .checkpoint(&self.session.cwd, id.clone(), persist)?;
        } else {
            persist()?;
        }
        self.history.push(item);
        self.summarized = false;
        Ok(())
    }

    fn push(&mut self, item: Item) -> Result<()> {
        self.history.push(self.sink.item(item, &self.session)?);
        self.summarized = false;
        Ok(())
    }

    fn state(&mut self, state: AgentState) -> Result<()> {
        self.sink.emit(AgentEvent::StateChanged { state })
    }

    fn request(&self) -> Result<ProviderRequest> {
        let mut tools = self.host.tools(&self.session)?;
        if let Some(schema) = &self.options.output_schema {
            if tools.iter().any(|tool| tool.name == "submit_output") {
                return Err(Error::Failed(
                    "submit_output is reserved for the output contract".into(),
                ));
            }
            tools.push(ToolDefinition { name: "submit_output".into(), description: "Submit the final response exactly once as an object matching the caller-provided JSON Schema. Text responses do not satisfy this output contract; correct and resubmit values rejected by the schema.".into(), parameters: schema.clone() });
        }
        for tool in &mut tools {
            tool.name = self.sink.redactor.redact(&tool.name);
            tool.description = self.sink.redactor.redact(&tool.description);
            tool.parameters = redaction::object(self.sink.redactor, &tool.parameters);
        }
        let instructions = format!(
            "{}\n\n{}",
            self.options.instructions,
            self.host.session_prompts(&self.session)?.join("\n\n")
        );
        let instructions = if let Some(tasks) = &self.session.tasks {
            format!(
                "{instructions}\n\n{}",
                tasks.instructions(&self.session.id)?
            )
        } else {
            instructions
        };
        let instructions = self.sink.redactor.redact(&instructions);
        let cache_key = history::cache_key(&self.options.model, &instructions, &tools);
        Ok(ProviderRequest {
            model: self.options.model.clone(),
            instructions,
            input: history::prepare(
                &self.history,
                &self.options.provider,
                &self.options.model,
                self.options.image_input,
            ),
            profile: self.options.profile.clone(),
            tools,
            thinking: self.options.thinking.clone(),
            cache_key,
            session_id: self.session.id.clone(),
            phase: crate::recording::Phase::Turn,
            attempt: 1,
        })
    }
}

pub fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(failure)?
        .as_millis()
        .try_into()
        .map_err(failure)
}

pub fn metadata(session: &Session, options: &Options, redactor: &Redactor) -> Result<Value> {
    let mut meta = json!({"version":2,"id":session.id,"cwd":redaction::path(redactor, &session.cwd.to_string_lossy()),"provider":redactor.redact(&options.provider),"model":redactor.redact(&options.model),"mode":options.mode,"startedAt":now()?});
    if let Some(thinking) = &options.thinking {
        meta["thinking"] = json!(thinking);
    }
    if let Some(profile) = &options.profile {
        meta["profile"] = json!(redactor.redact(profile));
    }
    Ok(json!({"type":"meta","meta":meta}))
}
