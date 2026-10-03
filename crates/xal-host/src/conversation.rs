use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonObject;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Replay {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub data: JsonObject,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Item {
    UserMessage {
        text: String,
        #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        #[serde(default)]
        images: Vec<Value>,
        #[serde(rename = "modelText", skip_serializing_if = "Option::is_none")]
        model_text: Option<String>,
    },
    AssistantMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        replay: Option<Replay>,
    },
    Reasoning {
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        replay: Option<Replay>,
    },
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        args: JsonObject,
        #[serde(skip_serializing_if = "Option::is_none")]
        replay: Option<Replay>,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        output: String,
    },
}

impl Item {
    pub fn user(text: String) -> Self {
        Self::UserMessage {
            text,
            message_id: None,
            images: Vec::new(),
            model_text: None,
        }
    }

    pub fn text(&self) -> &str {
        match self {
            Self::UserMessage { text, .. } | Self::AssistantMessage { text, .. } => text,
            Self::Reasoning { summary, .. } => summary,
            Self::ToolResult { output, .. } => output,
            Self::ToolCall { .. } => "",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

impl Usage {
    pub fn add(&mut self, other: &Self) {
        fn add(left: &mut Option<u64>, right: Option<u64>) {
            if let Some(right) = right {
                *left = Some(left.unwrap_or(0).saturating_add(right));
            }
        }
        add(&mut self.total_input_tokens, other.total_input_tokens);
        add(
            &mut self.cache_read_input_tokens,
            other.cache_read_input_tokens,
        );
        add(
            &mut self.cache_write_input_tokens,
            other.cache_write_input_tokens,
        );
        add(&mut self.output_tokens, other.output_tokens);
    }

    pub fn occupied(&self) -> u64 {
        self.total_input_tokens
            .unwrap_or(0)
            .saturating_add(self.output_tokens.unwrap_or(0))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: JsonObject,
}
