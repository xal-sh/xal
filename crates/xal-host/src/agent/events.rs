use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{JsonObject, Usage};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    Streaming,
    RunningTool,
    RunningHook,
    Compacting,
    AwaitingApproval,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    SessionStarted {
        id: String,
        cwd: String,
        resumed: bool,
        provider: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
        model: String,
        mode: String,
    },
    StateChanged {
        state: AgentState,
    },
    UserMessage {
        message_id: String,
        text: String,
        image_count: u32,
        sent_at: u64,
    },
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ReasoningSummaryDelta {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    ReasoningSummary {
        text: String,
    },
    ToolCallUpdated {
        call_id: String,
        tool: String,
        args: JsonObject,
    },
    ApprovalRequested {
        call_id: String,
        tool: String,
        title: String,
        read_only: bool,
    },
    ToolStarted {
        call_id: String,
        tool: String,
        title: String,
        read_only: bool,
    },
    ToolUpdated {
        call_id: String,
        text: String,
    },
    ToolFinished {
        call_id: String,
        tool: String,
        title: String,
        read_only: bool,
        output: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        denial: Option<String>,
    },
    RetryScheduled {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        message: String,
    },
    Compacted {
        summary: String,
        replaced: usize,
        tokens_before: u64,
    },
    ContextUpdated {
        context: Usage,
    },
    QueueChanged {
        entries: Vec<QueuedEntry>,
    },
    QueueFlushed {
        inputs: Vec<Input>,
    },
    TurnEnded {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<JsonObject>,
    },
    TurnFailed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<Usage>,
    },
    TurnInterrupted,
    Error {
        message: String,
    },
}

impl AgentEvent {
    pub(super) fn persistable(&self) -> bool {
        match self {
            Self::UserMessage { .. }
            | Self::AssistantMessage { .. }
            | Self::ReasoningSummary { .. }
            | Self::ToolCallUpdated { .. }
            | Self::ToolFinished { .. }
            | Self::Compacted { .. }
            | Self::TurnEnded { .. }
            | Self::TurnFailed { .. }
            | Self::TurnInterrupted
            | Self::Error { .. } => true,
            Self::SessionStarted { .. }
            | Self::StateChanged { .. }
            | Self::TextDelta { .. }
            | Self::ReasoningDelta { .. }
            | Self::ReasoningSummaryDelta { .. }
            | Self::ApprovalRequested { .. }
            | Self::ToolStarted { .. }
            | Self::ToolUpdated { .. }
            | Self::RetryScheduled { .. }
            | Self::ContextUpdated { .. }
            | Self::QueueChanged { .. }
            | Self::QueueFlushed { .. } => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedEntry {
    pub text: String,
    pub image_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Input {
    pub text: String,
    pub images: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Completed {
        response: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<Usage>,
    },
    Failed {
        response: Value,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<Usage>,
    },
    Interrupted {
        response: Value,
    },
}

impl Outcome {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Completed { .. } => 0,
            Self::Failed { .. } => 1,
            Self::Interrupted { .. } => 130,
        }
    }
}
