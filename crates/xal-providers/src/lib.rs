pub mod auth;
pub mod catalog;
mod chat;
pub mod client;
pub mod decision;
mod gemini;
mod messages;
pub mod profiles;
pub mod responses;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use xal_host::{Error, Item, JsonObject, Replay, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Id {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "openai-chatgpt")]
    ChatGpt,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "google")]
    Google,
    #[serde(rename = "github-copilot")]
    Copilot,
    #[serde(rename = "xai")]
    Xai,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "alibaba-cloud")]
    Alibaba,
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "minimax")]
    MiniMax,
    #[serde(rename = "minimax-coding-plan")]
    MiniMaxPlan,
    #[serde(rename = "opencode-go")]
    Go,
    #[serde(rename = "typesafe")]
    TypeSafe,
}

impl Id {
    pub const ALL: [Self; 13] = [
        Self::OpenAi,
        Self::ChatGpt,
        Self::Anthropic,
        Self::Google,
        Self::Copilot,
        Self::Xai,
        Self::DeepSeek,
        Self::Alibaba,
        Self::OpenRouter,
        Self::MiniMax,
        Self::MiniMaxPlan,
        Self::Go,
        Self::TypeSafe,
    ];

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "openai" | "openai-api" => Ok(Self::OpenAi),
            "openai-chatgpt" | "chatgpt" => Ok(Self::ChatGpt),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "google" | "gemini" => Ok(Self::Google),
            "github-copilot" | "copilot" => Ok(Self::Copilot),
            "xai" | "grok" => Ok(Self::Xai),
            "deepseek" => Ok(Self::DeepSeek),
            "alibaba-cloud" | "dashscope" => Ok(Self::Alibaba),
            "openrouter" => Ok(Self::OpenRouter),
            "minimax" => Ok(Self::MiniMax),
            "minimax-coding-plan" => Ok(Self::MiniMaxPlan),
            "opencode-go" => Ok(Self::Go),
            "typesafe" | "typesafeai" => Ok(Self::TypeSafe),
            _ => Err(Error::Failed(format!("unknown provider: {value}"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::ChatGpt => "openai-chatgpt",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
            Self::Copilot => "github-copilot",
            Self::Xai => "xai",
            Self::DeepSeek => "deepseek",
            Self::Alibaba => "alibaba-cloud",
            Self::OpenRouter => "openrouter",
            Self::MiniMax => "minimax",
            Self::MiniMaxPlan => "minimax-coding-plan",
            Self::Go => "opencode-go",
            Self::TypeSafe => "typesafe",
        }
    }

    pub fn plugin(self) -> &'static str {
        match self {
            Self::ChatGpt => "openai",
            Self::MiniMaxPlan => "minimax",
            _ => self.as_str(),
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::ChatGpt => "https://chatgpt.com/backend-api/codex",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Google => "https://generativelanguage.googleapis.com/v1beta",
            Self::Copilot => "https://api.githubcopilot.com",
            Self::Xai => "https://api.x.ai/v1",
            Self::DeepSeek => "https://api.deepseek.com",
            Self::Alibaba => "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
            Self::MiniMax | Self::MiniMaxPlan => "https://api.minimax.io/anthropic/v1",
            Self::Go => "https://opencode.ai/zen/go/v1",
            Self::TypeSafe => "https://api.typesafe.ai/v1",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Protocol {
    #[serde(rename = "/responses")]
    Responses,
    #[serde(rename = "/chat/completions")]
    Chat,
    #[serde(rename = "/messages")]
    Messages,
    #[serde(rename = "gemini")]
    Gemini,
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
fn provider_error(message: String, retryable: bool) -> Error {
    Error::Provider {
        message,
        retryable,
        retry_after_ms: None,
    }
}
fn invalid(message: &str) -> Error {
    provider_error(message.into(), false)
}
fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("provider response has invalid {field}")))
}
fn count(value: Option<&Value>) -> Result<Option<u64>> {
    value
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_u64()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| invalid("invalid provider usage count"))
        })
        .transpose()
}
fn replay(item: &Item, id: Id, model: &str) -> Option<Value> {
    let replay = match item {
        Item::AssistantMessage { replay, .. }
        | Item::Reasoning { replay, .. }
        | Item::ToolCall { replay, .. } => replay.as_ref(),
        _ => None,
    }?;
    (replay.provider == id.as_str() && replay.model.as_deref().is_none_or(|m| m == model))
        .then(|| Value::Object(replay.data.clone()))
}
fn replay_of(id: Id, model: &str, value: &Value) -> Result<Option<Replay>> {
    Ok(Some(Replay {
        provider: id.as_str().into(),
        model: Some(model.into()),
        data: value
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("invalid replay object"))?,
    }))
}
fn image(image: &Value) -> Result<(&str, &str)> {
    let media = string(image, "mediaType")?;
    let data = string(image, "data")?;
    if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&media) || data.is_empty() {
        return Err(invalid("invalid image attachment"));
    }
    Ok((media, data))
}
fn object(value: Value) -> Result<JsonObject> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("expected JSON object"))
}
