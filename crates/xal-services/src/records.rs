use std::io;
use std::path::Path;

use serde_json::{Map, Value};

use crate::storage::{invalid, read_text};

mod events;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordKind {
    Meta,
    Item,
    Event,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    kind: RecordKind,
    raw: Map<String, Value>,
}

impl Record {
    pub fn parse(line: &str) -> io::Result<Self> {
        let raw: Map<String, Value> =
            serde_json::from_str(line).map_err(|_| invalid("malformed session record"))?;
        let kind = match raw.get("type").and_then(Value::as_str) {
            Some("meta") => {
                let meta = object(&raw, "meta")?;
                if meta.get("version").and_then(Value::as_f64) != Some(2.0) {
                    return Err(invalid("unsupported session version"));
                }
                for field in ["id", "cwd", "provider", "model", "mode"] {
                    text(meta, field, true)?;
                }
                for field in ["parentId", "profile", "modeBeforePlan"] {
                    if meta.contains_key(field) {
                        text(meta, field, true)?;
                    }
                }
                RecordKind::Meta
            }
            Some("item") => {
                item(object(&raw, "item")?, true)?;
                RecordKind::Item
            }
            Some("event") => {
                let event = object(&raw, "event")?;
                events::validate(event)?;
                RecordKind::Event
            }
            _ => return Err(invalid("unknown session record type")),
        };
        Ok(Self { kind, raw })
    }

    pub fn kind(&self) -> RecordKind {
        self.kind
    }

    pub fn encode(&self) -> io::Result<String> {
        Ok(serde_json::to_string(&self.raw)?)
    }

    pub fn payload(&self) -> &Map<String, Value> {
        &self.raw
    }
}

pub fn read_journal(path: &Path) -> io::Result<Vec<Record>> {
    let content = read_text(path)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "session journal does not exist"))?;
    content
        .lines()
        .enumerate()
        .map(|(index, line)| {
            Record::parse(line)
                .map_err(|error| invalid(format!("session record {}: {error}", index + 1)))
        })
        .collect()
}

fn object<'a>(raw: &'a Map<String, Value>, field: &str) -> io::Result<&'a Map<String, Value>> {
    raw.get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("session {field} must be an object")))
}

fn text<'a>(raw: &'a Map<String, Value>, field: &str, nonempty: bool) -> io::Result<&'a str> {
    raw.get(field)
        .and_then(Value::as_str)
        .filter(|value| !nonempty || !value.is_empty())
        .ok_or_else(|| invalid(format!("invalid session {field}")))
}

fn message_id(raw: &Map<String, Value>, required: bool) -> io::Result<()> {
    if !required && !raw.contains_key("messageId") {
        return Ok(());
    }
    let id = text(raw, "messageId", true)?.as_bytes();
    if id.len() != 36
        || ![8, 13, 18, 23].iter().all(|index| id[*index] == b'-')
        || id[14] != b'4'
        || !b"89abAB".contains(&id[19])
        || !id
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
    {
        return Err(invalid("invalid session message ID"));
    }
    Ok(())
}

fn item(raw: &Map<String, Value>, history: bool) -> io::Result<()> {
    if raw.contains_key("replay") {
        let replay = object(raw, "replay")?;
        text(replay, "provider", true)?;
        object(replay, "data")?;
        if replay.contains_key("model") {
            text(replay, "model", true)?;
        }
    }
    match text(raw, "type", true)? {
        "user_message" => {
            text(raw, "text", false)?;
            message_id(raw, false)?;
            if raw.contains_key("modelText") {
                text(raw, "modelText", false)?;
            }
            if let Some(images) = raw.get("images") {
                for image in images
                    .as_array()
                    .ok_or_else(|| invalid("invalid session images"))?
                {
                    let image = image
                        .as_object()
                        .ok_or_else(|| invalid("invalid session image"))?;
                    if !["image/png", "image/jpeg"].contains(&text(image, "mediaType", true)?) {
                        return Err(invalid("invalid session image type"));
                    }
                    let data = text(image, "data", true)?;
                    let unpadded = data.trim_end_matches('=');
                    if data.len() % 4 != 0
                        || data.len() - unpadded.len() > 2
                        || unpadded.is_empty()
                        || !unpadded.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'
                        })
                    {
                        return Err(invalid("invalid session image encoding"));
                    }
                }
            }
        }
        "assistant_message" => {
            text(raw, "text", false)?;
        }
        "reasoning" => {
            text(raw, "summary", false)?;
        }
        "tool_call" => {
            text(raw, "callId", true)?;
            text(raw, "name", true)?;
            object(raw, "args")?;
        }
        "tool_result" => {
            text(raw, "callId", true)?;
            text(raw, "output", false)?;
        }
        "direct_shell" if history => {
            message_id(raw, true)?;
            text(raw, "callId", true)?;
            for field in ["input", "command", "output"] {
                text(raw, field, false)?;
            }
            if raw.get("readOnly").and_then(Value::as_bool).is_none() {
                return Err(invalid("invalid shell readOnly"));
            }
            if raw.contains_key("denial")
                && !["user", "policy", "plan", "hook"].contains(&text(raw, "denial", true)?)
            {
                return Err(invalid("invalid shell denial"));
            }
        }
        "compaction" if history => {
            text(raw, "summary", true)?;
            if !raw.get("replaced").is_some_and(Value::is_number)
                || raw
                    .get("tokensBefore")
                    .is_some_and(|value| !value.is_number())
            {
                return Err(invalid("invalid compaction counts"));
            }
            let strategy = if raw.contains_key("strategy") {
                Some(text(raw, "strategy", true)?)
            } else {
                None
            };
            if strategy.is_some_and(|value| value != "user_messages_v1" && value != "jev_v1") {
                return Err(invalid("invalid compaction strategy"));
            }
            let retained = raw
                .get("retained")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("invalid compaction retained items"))?;
            for value in retained {
                let retained = value
                    .as_object()
                    .ok_or_else(|| invalid("invalid compaction item"))?;
                item(retained, false)?;
                if strategy == Some("user_messages_v1") {
                    message_id(retained, true)?;
                    if retained.get("type").and_then(Value::as_str) != Some("user_message")
                        || retained
                            .get("images")
                            .and_then(Value::as_array)
                            .is_some_and(|images| !images.is_empty())
                    {
                        return Err(invalid("invalid retained user message"));
                    }
                }
            }
        }
        _ => return Err(invalid("unknown session item type")),
    }
    Ok(())
}
