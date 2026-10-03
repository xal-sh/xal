use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde_json::{Map, Value};

use crate::{Cancellation, Item, Result, ToolDefinition, Usage};

pub type JsonObject = Map<String, Value>;
pub type Call<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub type Handler<I, O> = Box<dyn Fn(I, Context) -> Call<'static, O> + Send + Sync>;

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
    pub available: fn(&Session) -> bool,
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
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    TextDelta(String),
    ReasoningDelta(String),
    ReasoningSummaryDelta(String),
    Item(Item),
    Done { usage: Option<Usage> },
}

pub struct Provider {
    pub models: Vec<String>,
    pub stream: Box<
        dyn Fn(ProviderRequest, Context, crate::Sender<ProviderEvent>) -> Call<'static, ()>
            + Send
            + Sync,
    >,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DecisionQuestion {
    Noul {
        instructions: Value,
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

#[derive(Clone, Debug, PartialEq)]
pub enum DecisionAnswer {
    Noul(f64),
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
    Score {
        score: f64,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionRequest {
    pub model: String,
    pub state: Value,
    pub questions: BTreeMap<String, DecisionQuestion>,
}

pub type DecisionResponse = BTreeMap<String, DecisionAnswer>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiContribution {
    Status { label: String, value: String },
    Text { text: String },
    Tool { name: String, output: String },
}
