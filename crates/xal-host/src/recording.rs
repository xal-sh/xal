use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use xal_services::{
    credentials::new_id,
    redactor::Redactor,
    storage::{create_secure, read_text},
};

use crate::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Turn,
    Compaction,
    GoalEvaluation,
    Classification,
    ReadAhead,
    CodeSearch,
    ReasoningRouting,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Interrupted,
}
impl Outcome {
    pub(crate) fn of<T>(result: &Result<T>) -> Self {
        match result {
            Ok(_) => Self::Completed,
            Err(Error::Cancelled) => Self::Interrupted,
            Err(_) => Self::Failed,
        }
    }
}

struct Log {
    path: PathBuf,
    file: Option<File>,
    failure: Option<String>,
}
impl Log {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            failure: None,
        }
    }
    fn write(&mut self, value: &Value) -> Result<()> {
        if let Some(error) = &self.failure {
            return Err(failure(format!("recording unavailable: {error}")));
        }
        let result = (|| {
            if self.file.is_none() {
                let parent = self
                    .path
                    .parent()
                    .ok_or_else(|| failure("recording path has no parent"))?;
                crate::agent::storage::secure_directory(parent)?;
                self.file = Some(create_secure(&self.path).map_err(failure)?);
            }
            let file = self
                .file
                .as_mut()
                .ok_or_else(|| failure("recording file unavailable"))?;
            writeln!(file, "{value}").map_err(failure)?;
            file.sync_data().map_err(failure)
        })();
        if let Err(error) = &result {
            self.failure = Some(error.to_string());
        }
        result
    }
}
struct State {
    usage: Log,
    profile: Option<Log>,
    labels: BTreeMap<String, BTreeMap<String, String>>,
    sequence: usize,
}
pub struct Recorder {
    state: Mutex<State>,
    started: Instant,
    redactor: Arc<Redactor>,
}

impl Recorder {
    pub fn new(home: &Path, profile: bool, redactor: Arc<Redactor>) -> Result<Arc<Self>> {
        let profile = if profile {
            Some(Log::new(home.join("profiler").join(format!(
                "profile-{}.jsonl",
                new_id().map_err(failure)?
            ))))
        } else {
            None
        };
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                usage: Log::new(
                    home.join("usage")
                        .join(format!("{}.jsonl", new_id().map_err(failure)?)),
                ),
                profile,
                labels: BTreeMap::new(),
                sequence: 0,
            }),
            started: Instant::now(),
            redactor,
        }))
    }
    pub fn start(
        self: &Arc<Self>,
        provider: &str,
        model: &str,
        session: &Session,
        phase: Phase,
        thinking: Option<&str>,
        attempt: u32,
    ) -> Result<Arc<Request>> {
        let mut state = self.state.lock().map_err(failure)?;
        if let Some(error) = &state.usage.failure {
            return Err(failure(format!("usage recorder is unavailable: {error}")));
        }
        state.sequence += 1;
        let request = format!("request-{}", state.sequence);
        let session_label = label(&mut state, "session", &session.id);
        let provider_label = label(&mut state, "provider", provider);
        let model_label = label(&mut state, "model", model);
        self.profile(&mut state, json!({"type":"provider_request_started","request":request,"session":session_label,"kind":kind(&session.kind),"phase":phase,"provider":provider_label,"model":model_label,"thinking":thinking.filter(|v| ["none", "low", "medium", "high", "xhigh", "max"].contains(v)),"attempt":attempt}));
        Ok(Arc::new(Request {
            recorder: self.clone(),
            id: request,
            session: session.id.clone(),
            provider: self.redactor.redact(provider),
            model: Mutex::new(self.redactor.redact(model)),
            phase,
            started: Instant::now(),
            first: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            usage: Mutex::new(None),
        }))
    }
    fn profile(&self, state: &mut State, mut value: Value) {
        value["atMs"] = json!(self.started.elapsed().as_millis());
        if let Some(log) = &mut state.profile
            && let Err(error) = log.write(&value)
        {
            eprintln!(
                "{}",
                self.redactor.redact(&format!("profiler stopped: {error}"))
            );
            state.profile = None;
        }
    }
    pub fn compaction(&self, session: &Session, shape: CompactionShape) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        let session_label = label(&mut state, "session", &session.id);
        self.profile(&mut state, json!({"type":"compaction_shape","session":session_label,"kind":kind(&session.kind),"shape":shape}));
        Ok(())
    }
    pub fn read_ahead(
        &self,
        session: &Session,
        candidates: usize,
        files: usize,
        bytes: usize,
        outcome: Outcome,
    ) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        let session_label = label(&mut state, "session", &session.id);
        self.profile(&mut state, json!({"type":"read_ahead_shape","session":session_label,"kind":kind(&session.kind),"candidates":candidates,"files":files,"bytes":bytes,"outcome":outcome}));
        Ok(())
    }
    pub(crate) fn turn(
        &self,
        session: &Session,
        result: &Result<()>,
        context: Option<&Usage>,
    ) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        let session_label = label(&mut state, "session", &session.id);
        let event = match result {
            Ok(()) => "turn_ended",
            Err(Error::Cancelled) => "turn_interrupted",
            Err(_) => "turn_failed",
        };
        self.profile(&mut state, json!({"type":"agent_event","session":session_label,"kind":kind(&session.kind),"event":{"type":event,"context":context}}));
        Ok(())
    }
    pub fn flush(&self) -> Result<()> {
        let state = self.state.lock().map_err(failure)?;
        if let Some(error) = &state.usage.failure {
            return Err(failure(format!("usage recorder is unavailable: {error}")));
        }
        if let Some(file) = &state.usage.file {
            file.sync_data().map_err(failure)?;
        }
        Ok(())
    }
}
fn label(state: &mut State, kind: &str, value: &str) -> String {
    let values = state.labels.entry(kind.into()).or_default();
    let next = format!("{kind}-{}", values.len() + 1);
    values.entry(value.into()).or_insert(next).clone()
}
fn kind(kind: &SessionKind) -> &'static str {
    match kind {
        SessionKind::Interactive | SessionKind::Headless => "primary",
        SessionKind::Task => "subagent",
    }
}

pub struct Request {
    recorder: Arc<Recorder>,
    id: String,
    session: String,
    provider: String,
    model: Mutex<String>,
    phase: Phase,
    started: Instant,
    first: AtomicBool,
    finished: AtomicBool,
    usage: Mutex<Option<Usage>>,
}
impl Request {
    pub fn model(&self, model: &str) -> Result<()> {
        *self.model.lock().map_err(failure)? = self.recorder.redactor.redact(model);
        Ok(())
    }
    pub fn usage(&self, usage: Usage) -> Result<()> {
        *self.usage.lock().map_err(failure)? = Some(usage);
        Ok(())
    }
    pub fn event(&self, event: &ProviderEvent) -> Result<()> {
        match event {
            ProviderEvent::Usage(usage) | ProviderEvent::Done { usage: Some(usage) } => {
                self.usage(usage.clone())?
            }
            _ => {}
        }
        if self.first.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let event = match event {
            ProviderEvent::TextDelta(_) => "text_delta",
            ProviderEvent::ReasoningDelta(_) => "reasoning_delta",
            ProviderEvent::ReasoningSummaryDelta(_) => "reasoning_summary_delta",
            ProviderEvent::Item(_) => "item",
            ProviderEvent::Usage(_) => "usage",
            ProviderEvent::Done { .. } => "done",
        };
        let mut state = self.recorder.state.lock().map_err(failure)?;
        self.recorder.profile(&mut state, json!({"type":"provider_first_event","request":self.id,"event":event,"elapsedMs":self.started.elapsed().as_millis()}));
        Ok(())
    }
    pub fn decision_shape(&self, request: &DecisionRequest) -> Result<()> {
        let mut state = self.recorder.state.lock().map_err(failure)?;
        self.recorder.profile(&mut state, json!({"type":"provider_request_shape","request":self.id,"shape":{"stateBytes":request.state.to_string().len(),"questionCount":request.questions.len(),"questionBytes":serde_json::to_vec(&request.questions).map_err(failure)?.len()}}));
        Ok(())
    }
    pub fn shape(&self, request: &ProviderRequest) -> Result<()> {
        let mut shape = json!({"user":{"count":0,"estimatedTokens":0},"assistant":{"count":0,"estimatedTokens":0},"reasoning":{"count":0,"estimatedTokens":0},"toolCall":{"count":0,"estimatedTokens":0},"toolResult":{"count":0,"estimatedTokens":0},"instructionBytes":request.instructions.len(),"toolCount":request.tools.len(),"schemaBytes":request.tools.iter().map(|t| json!(t.parameters).to_string().len()).sum::<usize>(),"estimatedInputTokens":0,"estimatedRequestTokens":crate::agent::context::estimate(request)});
        for item in &request.input {
            let field = match item {
                Item::UserMessage { .. } => "user",
                Item::AssistantMessage { .. } => "assistant",
                Item::Reasoning { .. } => "reasoning",
                Item::ToolCall { .. } => "toolCall",
                Item::ToolResult { .. } => "toolResult",
            };
            shape[field]["count"] = json!(shape[field]["count"].as_u64().unwrap_or(0) + 1);
            let tokens = crate::agent::context::item_tokens(item);
            shape[field]["estimatedTokens"] =
                json!(shape[field]["estimatedTokens"].as_u64().unwrap_or(0) + tokens);
            shape["estimatedInputTokens"] =
                json!(shape["estimatedInputTokens"].as_u64().unwrap_or(0) + tokens);
        }
        let mut state = self.recorder.state.lock().map_err(failure)?;
        self.recorder.profile(
            &mut state,
            json!({"type":"provider_request_shape","request":self.id,"shape":shape}),
        );
        Ok(())
    }
    pub fn finish<T>(&self, result: &Result<T>) -> Result<()> {
        if self.finished.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let usage = self.usage.lock().map_err(failure)?.clone();
        let outcome = Outcome::of(result);
        let mut state = self.recorder.state.lock().map_err(failure)?;
        self.recorder.profile(&mut state, json!({"type":"provider_request_finished","request":self.id,"outcome":outcome,"elapsedMs":self.started.elapsed().as_millis(),"usage":usage}));
        if let Some(usage) = usage {
            let recorded = (|| {
                let value = json!({"type":"provider_usage","version":2,"id":new_id().map_err(failure)?,"timestamp":timestamp()? ,"session":fingerprint(&self.session),"provider":self.recorder.redactor.redact(&self.provider),"model":self.recorder.redactor.redact(self.model.lock().map_err(failure)?.as_str()),"phase":self.phase,"outcome":outcome,"usage":{"totalInputTokens":usage.total_input_tokens.unwrap_or_else(|| usage.cache_read_input_tokens.unwrap_or(0).saturating_add(usage.cache_write_input_tokens.unwrap_or(0))),"cacheReadInputTokens":usage.cache_read_input_tokens.unwrap_or(0),"cacheWriteInputTokens":usage.cache_write_input_tokens.unwrap_or(0),"outputTokens":usage.output_tokens.unwrap_or(0)}});
                parse_usage(&value)?;
                state.usage.write(&value)
            })();
            if let Err(error) = &recorded {
                state.usage.failure = Some(error.to_string());
            }
            recorded?;
        }
        Ok(())
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Err(error) = self.finish::<()>(&Err(Error::Cancelled)) {
            eprintln!(
                "{}",
                self.recorder
                    .redactor
                    .redact(&format!("usage recorder failed: {error}"))
            );
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionShape {
    pub trigger: &'static str,
    pub strategy: &'static str,
    pub outcome: Outcome,
    pub tokens_before: u64,
    pub estimated_before: u64,
    pub estimated_after: u64,
    pub retained_authored_users: usize,
    pub retained_authored_user_tokens: u64,
    pub summary_estimated_tokens: u64,
    pub removed: BTreeMap<&'static str, usize>,
}

pub fn fingerprint(session: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("xal-usage-session-v1\0{session}"))
    )
}
fn timestamp() -> Result<String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(failure)?;
    let mut days = time.as_secs() / 86400;
    let mut year = 1970u64;
    loop {
        let count = if leap(year) { 366 } else { 365 };
        if days < count {
            break;
        }
        days -= count;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for count in months {
        if days < count {
            break;
        }
        days -= count;
        month += 1;
    }
    let seconds = time.as_secs() % 86400;
    Ok(format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        days + 1,
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        time.subsec_millis()
    ))
}
fn leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}
pub fn parse_usage(value: &Value) -> Result<Usage> {
    if value["type"] != "provider_usage" || ![Some(1), Some(2)].contains(&value["version"].as_u64())
    {
        return Err(failure("invalid usage record version"));
    }
    for field in ["id", "timestamp", "provider", "model"] {
        if value[field].as_str().is_none_or(|s| s.is_empty()) {
            return Err(failure("invalid usage record identity"));
        }
    }
    serde_json::from_value::<Phase>(value["phase"].clone()).map_err(failure)?;
    serde_json::from_value::<Outcome>(value["outcome"].clone()).map_err(failure)?;
    if value["version"] == 2
        && !value["session"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(failure("invalid usage session fingerprint"));
    }
    if !valid_timestamp(value["timestamp"].as_str().unwrap_or("")) {
        return Err(failure("invalid usage timestamp"));
    }
    let usage: Usage = serde_json::from_value(value["usage"].clone()).map_err(failure)?;
    if [
        usage.total_input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_write_input_tokens,
        usage.output_tokens,
    ]
    .iter()
    .any(|v| !v.is_some_and(|n| n <= 9_007_199_254_740_991))
    {
        return Err(failure("invalid usage token count"));
    }
    Ok(usage)
}
pub fn read_usage(directory: &Path) -> Result<Value> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"requests":0,"usage":Usage::default()}));
        }
        Err(error) => return Err(failure(error)),
    };
    let mut usage = Usage::default();
    let mut requests = 0;
    for entry in entries {
        let entry = entry.map_err(failure)?;
        if !entry.file_type().map_err(failure)?.is_file()
            || entry.path().extension().is_none_or(|e| e != "jsonl")
        {
            continue;
        }
        let text = read_text(&entry.path())
            .map_err(failure)?
            .ok_or_else(|| failure("usage file disappeared"))?;
        for line in text.lines() {
            let next = parse_usage(&serde_json::from_str::<Value>(line).map_err(failure)?)?;
            let sum = |a: Option<u64>, b: Option<u64>| {
                a.unwrap_or(0)
                    .checked_add(b.unwrap_or(0))
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .map(Some)
                    .ok_or_else(|| failure("usage total exceeds safe integer range"))
            };
            usage = Usage {
                total_input_tokens: sum(usage.total_input_tokens, next.total_input_tokens)?,
                cache_read_input_tokens: sum(
                    usage.cache_read_input_tokens,
                    next.cache_read_input_tokens,
                )?,
                cache_write_input_tokens: sum(
                    usage.cache_write_input_tokens,
                    next.cache_write_input_tokens,
                )?,
                output_tokens: sum(usage.output_tokens, next.output_tokens)?,
            };
            requests += 1;
        }
    }
    Ok(json!({"requests":requests,"usage":usage}))
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || !bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            19 => *b == b'.',
            23 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0u64, |n, b| n * 10 + u64::from(b - b'0'))
    };
    let month = number(5, 7);
    let day = number(8, 10);
    let maximum = match month {
        4 | 6 | 9 | 11 => 30,
        2 if leap(number(0, 4)) => 29,
        2 => 28,
        1..=12 => 31,
        _ => return false,
    };
    day > 0 && day <= maximum && number(11, 13) < 24 && number(14, 16) < 60 && number(17, 19) < 60
}
