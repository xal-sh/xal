use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use xal_services::records::{Record, RecordKind};

use crate::*;

pub fn active(records: &[Record]) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    for record in records {
        if record.kind() != RecordKind::Item {
            continue;
        }
        let raw = &record.payload()["item"];
        match raw["type"].as_str() {
            Some("direct_shell") => items.push(Item::user(format!("The user ran this shell command themselves in the session:\n<shell-input>\n{}\n</shell-input>\n<shell-output>\n{}\n</shell-output>", text(raw, "command")?, text(raw, "output")?))),
            Some("compaction") => {
                let retained: Vec<Item> = serde_json::from_value(raw["retained"].clone()).map_err(super::failure)?;
                let summary = text(raw, "summary")?;
                items = match raw["strategy"].as_str() {
                    Some("jev_v1") => retained,
                    Some("user_messages_v1") => { let mut items = retained; items.push(summary_message(summary)); items },
                    None => { let mut items = vec![Item::user(format!("The earlier part of this conversation was summarized to free context. Treat the summary below as the authoritative record of everything that happened before the messages that follow.\n\n<conversation-summary>\n{summary}\n</conversation-summary>"))]; items.extend(retained); items },
                    _ => return Err(super::failure("unknown historical compaction strategy")),
                };
            }
            _ => items.push(serde_json::from_value(raw.clone()).map_err(super::failure)?),
        }
    }
    Ok(items)
}

fn text<'a>(raw: &'a Value, key: &str) -> Result<&'a str> {
    raw[key]
        .as_str()
        .ok_or_else(|| super::failure(format!("invalid historical {key}")))
}

pub(super) fn summary_message(summary: &str) -> Item {
    Item::user(format!(
        "The retained user requests and authoritative state summary below describe the coding work to continue.\n\n<conversation-summary>\n{summary}\n</conversation-summary>"
    ))
}

pub fn omit_images(item: &Item) -> Item {
    let Item::UserMessage {
        text,
        model_text,
        message_id,
        images,
    } = item
    else {
        return item.clone();
    };
    if images.is_empty() {
        return item.clone();
    }
    let notice = format!(
        "[{} image attachment{} omitted]",
        images.len(),
        if images.len() == 1 { "" } else { "s" }
    );
    let append = |text: &str| {
        if text.is_empty() {
            notice.clone()
        } else {
            format!("{text}\n\n{notice}")
        }
    };
    Item::UserMessage {
        text: append(text),
        model_text: model_text.as_deref().map(append),
        message_id: message_id.clone(),
        images: Vec::new(),
    }
}

pub fn prepare(items: &[Item], provider: &str, model: &str, images: bool) -> Vec<Item> {
    let mut result = Vec::new();
    let mut pending = Vec::<String>::new();
    let matches = |replay: &Option<Replay>| {
        replay
            .as_ref()
            .is_some_and(|r| r.provider == provider && r.model.as_ref().is_none_or(|m| m == model))
    };
    let finish = |result: &mut Vec<Item>, pending: &mut Vec<String>| {
        result.extend(pending.drain(..).map(|call_id| Item::ToolResult {
            call_id,
            output: "Tool execution was interrupted before returning a result.".into(),
        }));
    };
    for original in items {
        let mut item = original.clone();
        match &mut item {
            Item::UserMessage {
                text,
                model_text,
                message_id,
                ..
            } => {
                if let Some(value) = model_text.take() {
                    *text = value;
                }
                *message_id = None;
            }
            Item::Reasoning { replay, .. } if !matches(replay) => continue,
            Item::AssistantMessage { replay, .. } | Item::ToolCall { replay, .. }
                if !matches(replay) =>
            {
                *replay = None
            }
            _ => {}
        }
        match &item {
            Item::ToolCall { call_id, .. } => {
                if pending.contains(call_id) {
                    continue;
                }
                pending.push(call_id.clone());
            }
            Item::ToolResult { call_id, .. } => {
                let Some(index) = pending.iter().position(|id| id == call_id) else {
                    continue;
                };
                pending.remove(index);
            }
            _ => finish(&mut result, &mut pending),
        }
        result.push(if images { item } else { omit_images(&item) });
    }
    finish(&mut result, &mut pending);
    result
}

pub fn cache_key(model: &str, instructions: &str, tools: &[ToolDefinition]) -> String {
    let mut hash = Sha256::new();
    hash.update(model);
    hash.update(b"\0");
    hash.update(instructions);
    for tool in tools {
        for value in [
            &tool.name,
            &tool.description,
            &json!(tool.parameters).to_string(),
        ] {
            hash.update(b"\0");
            hash.update(value);
        }
    }
    format!("{:x}", hash.finalize())
}
