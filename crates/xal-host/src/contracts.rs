use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Cancellation, Item, Result, ToolDefinition, Usage};

pub type JsonObject = Map<String, Value>;
pub type Call<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub type Handler<I, O> = Box<dyn Fn(I, Context) -> Call<'static, O> + Send + Sync>;
pub type Availability = Box<dyn Fn(&Session) -> Result<bool> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionKind {
    Interactive,
    Headless,
    Task,
}

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub cwd: PathBuf,
    pub kind: SessionKind,
    pub read_only: bool,
    pub cancellation: Cancellation,
}

#[derive(Clone)]
pub struct Context {
    pub session: Session,
    pub cancellation: Cancellation,
    pub output: Option<crate::Sender<String>>,
    pub speculative: bool,
    pub decisions: Option<std::sync::Arc<crate::decisions::Service>>,
    pub observation: Option<std::sync::Arc<crate::recording::Request>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    SessionStarted {
        id: String,
    },
    ToolFinished {
        session: String,
        tool: String,
        output: String,
    },
    ProviderFinished {
        session: String,
        provider: String,
    },
    Diagnostic {
        session: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Abstain,
    Allow,
    Ask(String),
    Deny(String),
}

#[derive(Clone)]
pub struct PermissionRequest {
    pub tool: String,
    pub args: JsonObject,
    pub read_only: bool,
}

pub struct Tool {
    pub description: String,
    pub parameters: JsonObject,
    pub effects: fn(&JsonObject) -> Effects,
    pub redact: Option<fn(&JsonObject, &xal_services::redactor::Redactor) -> Result<JsonObject>>,
    pub available: Availability,
    pub run: Handler<JsonObject, ToolResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effects {
    Read,
    Write,
}

impl Effects {
    pub fn read(_: &JsonObject) -> Self {
        Self::Read
    }
    pub fn write(_: &JsonObject) -> Self {
        Self::Write
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResult {
    pub output: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HookInput {
    Prompt { text: String },
    BeforeTool { tool: String, args: JsonObject },
    AfterTool { tool: String, output: String },
    TurnEnd,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HookResult {
    Continue,
    ReplacePrompt(String),
    ReplaceArguments(JsonObject),
    ReplaceOutput(String),
    Block(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderRequest {
    pub model: String,
    pub instructions: String,
    pub input: Vec<Item>,
    pub profile: Option<String>,
    pub tools: Vec<ToolDefinition>,
    pub thinking: Option<String>,
    pub cache_key: String,
    pub session_id: String,
    pub phase: crate::recording::Phase,
    pub attempt: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    TextDelta(String),
    ReasoningDelta(String),
    ReasoningSummaryDelta(String),
    Item(Item),
    Usage(Usage),
    Done { usage: Option<Usage> },
}

pub struct Provider {
    pub settle: Option<Box<dyn Fn() -> Call<'static, ()> + Send + Sync>>,
    pub models: Vec<String>,
    pub stream: Box<
        dyn Fn(ProviderRequest, Context, crate::Sender<ProviderEvent>) -> Call<'static, ()>
            + Send
            + Sync,
    >,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum DecisionQuestion {
    Noul {
        instructions: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<BTreeMap<String, Value>>,
    },
    Choice {
        instructions: Value,
        criteria: BTreeMap<String, Value>,
    },
    Score {
        instructions: Value,
        criteria: Vec<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DecisionAnswer {
    Noul {
        noul: f64,
    },
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
    Score {
        score: f64,
        legend: BTreeMap<String, Value>,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    pub model: String,
    pub state: Value,
    pub questions: BTreeMap<String, DecisionQuestion>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DecisionResponse {
    pub model: String,
    pub answers: BTreeMap<String, DecisionAnswer>,
    pub usage: Usage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiContribution {
    Status { label: String, value: String },
    Text { text: String },
    Tool { name: String, output: String },
}
