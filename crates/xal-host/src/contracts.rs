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
pub type ToolSource =
    Box<dyn Fn(&Session) -> Result<BTreeMap<String, std::sync::Arc<Tool>>> + Send + Sync>;
pub type PromptSource = Box<dyn Fn(&Session) -> Result<String> + Send + Sync>;
pub type PermissionSubject = Box<dyn Fn(&JsonObject) -> Result<String> + Send + Sync>;
pub type ToolTitle = Box<dyn Fn(&JsonObject, &Session) -> Result<String> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionKind {
    Interactive,
    Headless,
    Task,
}

#[derive(Clone)]
pub struct Session {
    pub tasks: Option<std::sync::Arc<crate::tasks::Service>>,
    pub task: Option<std::sync::Arc<crate::tasks::Handle>>,
    pub undo_gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub undo: crate::undo::Shared,
    pub jobs: std::sync::Arc<crate::jobs::Jobs>,
    pub id: String,
    pub cwd: PathBuf,
    pub kind: SessionKind,
    pub read_only: bool,
    pub cancellation: Cancellation,
}

impl Session {
    pub fn display_path(&self, path: &str) -> Result<String> {
        if path.is_empty() {
            return Ok(String::new());
        }
        let absolute = crate::permissions::logical_path(&self.cwd, path)?;
        let relative = crate::permissions::display_path(&absolute, &self.cwd);
        if relative.is_empty()
            || relative.starts_with("..")
            || std::path::Path::new(&relative).is_absolute()
        {
            return Ok(if std::path::Path::new(path).is_absolute() {
                path.into()
            } else {
                absolute.to_string_lossy().into_owned()
            });
        }
        Ok(relative)
    }
}

#[derive(Clone)]
pub struct Context {
    pub task_options: Option<crate::agent::Options>,
    pub task_permissions: Option<crate::permissions::Permissions>,
    pub call_id: Option<String>,
    pub interactions: std::sync::Arc<crate::interactions::Interactions>,
    pub(crate) command_owners: std::sync::Arc<BTreeMap<String, String>>,
    pub(crate) workspace: Option<crate::workspace::Change>,
    pub session: Session,
    pub cancellation: Cancellation,
    pub output: Option<crate::Sender<String>>,
    pub speculative: bool,
    pub decisions: Option<std::sync::Arc<crate::decisions::Service>>,
    pub observation: Option<std::sync::Arc<crate::recording::Request>>,
}

impl Context {
    pub fn command_owner(&self, name: &str) -> Option<&str> {
        self.command_owners.get(name).map(String::as_str)
    }
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
    pub subject: Option<String>,
}

pub struct Tool {
    pub title: Option<ToolTitle>,
    pub description: String,
    pub parameters: JsonObject,
    pub effects: fn(&JsonObject) -> Effects,
    pub concurrency: Option<fn(&JsonObject) -> Concurrency>,
    pub permission_subject: Option<PermissionSubject>,
    pub redact: Option<fn(&JsonObject, &xal_services::redactor::Redactor) -> Result<JsonObject>>,
    pub available: Availability,
    pub run: Handler<JsonObject, ToolResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Concurrency {
    Shared,
    Exclusive,
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
