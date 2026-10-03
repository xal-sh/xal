pub(crate) mod context;
mod control;
mod events;
pub mod history;
mod intelligence;
mod jev;
mod loops;
mod read_ahead;
mod redaction;
mod sink;
pub(crate) mod storage;
mod stream;
mod tools;

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

pub struct SummaryTarget {
    pub model: String,
    pub thinking: Option<String>,
    pub image_input: bool,
    pub context_window: u64,
}

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
    context: Option<Usage>,
    measured_items: usize,
    summarized: bool,
    loops: loops::ToolLoops,
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
        Ok(Self {
            host,
            control: Control::new(session.cancellation.clone()),
            session,
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
            self.push(item)?;
        }
        Ok(())
    }

    pub async fn run(&mut self, input: Input) -> Result<Outcome> {
        let result = self.turn(input).await;
        let closed = self.control.close().and_then(|pending| {
            if !pending.is_empty() {
                self.sink
                    .emit(AgentEvent::QueueFlushed { inputs: pending })?;
            }
            Ok(())
        });
        let result = result.and(closed);
        let cleanup = self.host.dispose_session(&self.session).await;
        let result = match (result, cleanup) {
            (result, Ok(())) => result,
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(Error::Failed(format!(
                "{error}\nSession cleanup failed: {cleanup}"
            ))),
        };
        let response = match self.contract.as_ref().and_then(OutputContract::output) {
            Some(value) => self
                .sink
                .redactor
                .redact_json(&serde_json::from_str(&value).map_err(failure)?),
            None => Value::String(self.sink.response.clone()),
        };
        if let Some(recorder) = &self.host.recorder {
            recorder.turn(&self.session, &result, self.context.as_ref())?;
        }
        let outcome = match result {
            Ok(()) => {
                self.sink.emit(AgentEvent::TurnEnded {
                    usage: self.usage.clone(),
                    context: self.context.clone(),
                    output: response.as_object().cloned(),
                })?;
                Outcome::Completed {
                    response,
                    usage: self.usage.clone(),
                    context: self.context.clone(),
                }
            }
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

    async fn turn(&mut self, input: Input) -> Result<()> {
        self.sink.emit(AgentEvent::SessionStarted {
            id: self.session.id.clone(),
            cwd: self.session.cwd.to_string_lossy().into_owned(),
            resumed: !self.history.is_empty(),
            provider: self.options.provider.clone(),
            profile: self.options.profile.clone(),
            model: self.options.model.clone(),
            mode: self.options.mode.clone(),
        })?;
        self.input(input).await?;
        let mut interjected = false;
        loop {
            self.refresh_workspace()?;
            self.session.cancellation.check()?;
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
            if !calls.is_empty() {
                interjected = false;
                self.state(AgentState::RunningTool)?;
                let result = self.tools(calls, &active).await;
                if result == Err(Error::Cancelled) && self.control.steered()? {
                    continue;
                }
                result?;
                if let Some(contract) = &self.contract {
                    if contract.exhausted() {
                        return Err(Error::Failed(contract.failure()));
                    }
                    if contract.output().is_some() && self.control.finish_if_empty()? {
                        break;
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
            if self.control.finish_if_empty()? {
                break;
            }
        }
        self.state(AgentState::RunningHook)?;
        self.host.hook(HookInput::TurnEnd, &self.session).await?;
        self.session.cancellation.check()
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
        self.sink.emit(AgentEvent::UserMessage {
            message_id: message_id.clone(),
            text: input.text.clone(),
            image_count: input.images.len().try_into().map_err(failure)?,
            sent_at: now()?,
        })?;
        self.push(Item::UserMessage {
            model_text: (text != input.text).then_some(text),
            text: input.text,
            message_id: Some(message_id),
            images: input.images,
        })
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
    if let Some(profile) = &options.profile {
        meta["profile"] = json!(redactor.redact(profile));
    }
    Ok(json!({"type":"meta","meta":meta}))
}
