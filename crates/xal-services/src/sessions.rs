use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod export;

use crate::records::{Record, RecordKind};
use crate::storage::invalid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub version: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub cwd: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_before_plan: Option<String>,
    #[serde(default)]
    pub started_at: u64,
}

#[derive(Clone, Debug)]
pub struct Checkpoint {
    pub message_id: String,
    pub text: String,
    pub images: Vec<Value>,
    pub before: Vec<Value>,
}

#[derive(Clone, Debug, Default)]
pub struct Conversation {
    pub items: Vec<Value>,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Clone, Debug)]
pub struct Redo {
    pub message_id: String,
    pub prompt: String,
    pub state: Conversation,
}

impl Conversation {
    pub fn rewind(&self, message_id: &str) -> io::Result<(Self, Vec<Redo>)> {
        let index = self
            .checkpoints
            .iter()
            .position(|c| c.message_id == message_id)
            .ok_or_else(|| invalid("conversation checkpoint is unavailable"))?;
        let redos = self.checkpoints[index..]
            .iter()
            .enumerate()
            .map(|(offset, c)| Redo {
                message_id: c.message_id.clone(),
                prompt: c.text.clone(),
                state: Self {
                    items: self
                        .checkpoints
                        .get(index + offset + 1)
                        .map_or_else(|| self.items.clone(), |next| next.before.clone()),
                    checkpoints: self.checkpoints[..index + offset + 1].to_vec(),
                },
            })
            .collect();
        Ok((
            Self {
                items: self.checkpoints[index].before.clone(),
                checkpoints: self.checkpoints[..index].to_vec(),
            },
            redos,
        ))
    }
}

#[derive(Clone, Debug)]
pub struct Loaded {
    pub meta: Metadata,
    pub current: Metadata,
    pub conversation: Conversation,
    pub redos: Vec<Redo>,
    pub events: Vec<Value>,
    pub records: Vec<Record>,
    pub title: Option<String>,
    pub complete_bytes: u64,
    pub incomplete_tail: bool,
}

pub fn load(path: &Path) -> io::Result<Loaded> {
    use std::io::BufRead;
    let file = crate::storage::read_file(path)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "session does not exist"))?;
    let mut reader = io::BufReader::new(file);
    let mut bytes = Vec::new();
    let mut records = Vec::new();
    let mut complete_bytes = 0;
    let incomplete_tail = loop {
        bytes.clear();
        if reader.read_until(b'\n', &mut bytes)? == 0 {
            break false;
        }
        if bytes.last() != Some(&b'\n') {
            break true;
        }
        let line = std::str::from_utf8(&bytes)
            .map_err(|error| invalid(error.to_string()))?
            .trim_end_matches(['\r', '\n']);
        if !line.is_empty() {
            records.push(Record::parse(line).map_err(|error| {
                invalid(format!("session record {}: {error}", records.len() + 1))
            })?);
        }
        complete_bytes += bytes.len() as u64;
    };
    let mut loaded = replay(&records)?;
    loaded.complete_bytes = complete_bytes;
    loaded.incomplete_tail = incomplete_tail;
    Ok(loaded)
}

pub fn replay(records: &[Record]) -> io::Result<Loaded> {
    let first = records
        .first()
        .filter(|r| r.kind() == RecordKind::Meta)
        .ok_or_else(|| invalid("session must begin with metadata"))?;
    let meta: Metadata =
        serde_json::from_value(first.payload()["meta"].clone()).map_err(invalid_json)?;
    let mut loaded = Loaded {
        current: meta.clone(),
        meta,
        conversation: Conversation::default(),
        redos: Vec::new(),
        events: Vec::new(),
        records: records.to_vec(),
        title: None,
        complete_bytes: 0,
        incomplete_tail: false,
    };
    let mut seen = HashSet::new();
    let mut pending: Option<&Value> = None;
    for record in &records[1..] {
        match record.kind() {
            RecordKind::Meta => return Err(invalid("session contains duplicate metadata")),
            RecordKind::Item => {
                let item = &record.payload()["item"];
                let kind = text(item, "type")?;
                if kind == "compaction" {
                    loaded.conversation.items = vec![item.clone()];
                    pending = None;
                    continue;
                }
                if ["user_message", "direct_shell"].contains(&kind) {
                    loaded.redos.clear();
                    if let Some(id) = item.get("messageId").and_then(Value::as_str) {
                        let event = pending
                            .take()
                            .ok_or_else(|| invalid("message item has no matching event"))?;
                        let field = if kind == "direct_shell" {
                            "input"
                        } else {
                            "text"
                        };
                        let images = item["images"].as_array().cloned().unwrap_or_default();
                        let matched = if kind == "direct_shell" {
                            event["type"] == "shell_finished"
                                && ["callId", "input", "command", "output", "readOnly", "denial"]
                                    .iter()
                                    .all(|key| event[*key] == item[*key])
                        } else {
                            event["type"] == "user_message"
                                && event["text"] == item["text"]
                                && event["imageCount"].as_u64().unwrap_or(0)
                                    == u64::try_from(images.len()).map_err(io::Error::other)?
                        };
                        if !matched || event["messageId"] != id || !seen.insert(id.to_owned()) {
                            return Err(invalid(
                                "message identity does not match its event or is duplicated",
                            ));
                        }
                        loaded.events.push(event.clone());
                        loaded.conversation.checkpoints.push(Checkpoint {
                            message_id: id.into(),
                            text: text(item, field)?.into(),
                            images,
                            before: loaded.conversation.items.clone(),
                        });
                    }
                }
                loaded.conversation.items.push(item.clone());
                pending = None;
            }
            RecordKind::Event => {
                let event = &record.payload()["event"];
                let kind = text(event, "type")?;
                pending = None;
                match kind {
                    "reasoning_routed" | "request_measured" => continue,
                    "user_message" if event.get("messageId").is_some() => {
                        pending = Some(event);
                        continue;
                    }
                    "shell_finished" => {
                        pending = Some(event);
                        continue;
                    }
                    "user_message" => loaded.redos.clear(),
                    "conversation_rewound" => {
                        let (state, redos) =
                            loaded.conversation.rewind(text(event, "messageId")?)?;
                        if event["removedMessages"].as_u64() != u64::try_from(redos.len()).ok()
                            || redos.first().is_none_or(|r| event["prompt"] != r.prompt)
                        {
                            return Err(invalid("conversation rewind disagrees with checkpoint"));
                        }
                        loaded.redos.extend(redos.into_iter().rev());
                        loaded.conversation = state;
                    }
                    "conversation_redone" => {
                        let redo = loaded
                            .redos
                            .pop()
                            .ok_or_else(|| invalid("conversation redo is unavailable"))?;
                        if event["messageId"] != redo.message_id
                            || event["prompt"] != redo.prompt
                            || event["restoredMessages"].as_u64()
                                != redo
                                    .state
                                    .checkpoints
                                    .len()
                                    .checked_sub(loaded.conversation.checkpoints.len())
                                    .and_then(|n| u64::try_from(n).ok())
                        {
                            return Err(invalid("conversation redo disagrees with checkpoint"));
                        }
                        loaded.conversation = redo.state;
                    }
                    "tool_call_updated" => {
                        let item = loaded
                            .conversation
                            .items
                            .iter_mut()
                            .rev()
                            .find(|i| i["type"] == "tool_call" && i["callId"] == event["callId"])
                            .ok_or_else(|| invalid("tool update has no matching call"))?;
                        if !event["args"].is_object() {
                            return Err(invalid("invalid effective tool arguments"));
                        }
                        if item["name"] != event["tool"] || item["args"] != event["args"] {
                            *item = json!({"type":"tool_call","callId":text(event,"callId")?,"name":text(event,"tool")?,"args":event["args"]});
                        }
                    }
                    "workspace_changed" => loaded.current.cwd = text(event, "cwd")?.into(),
                    "model_changed" => {
                        loaded.current.provider = text(event, "provider")?.into();
                        loaded.current.model = text(event, "model")?.into();
                        loaded.current.profile = optional_text(event, "profile")?;
                    }
                    "thinking_changed" => {
                        loaded.current.thinking = optional_text(event, "thinking")?
                    }
                    "mode_changed" => {
                        let mode = text(event, "mode")?;
                        if mode == "plan" && loaded.current.mode != "plan" {
                            loaded.current.mode_before_plan = Some(loaded.current.mode.clone());
                        }
                        if mode != "plan" {
                            loaded.current.mode_before_plan = None;
                        }
                        loaded.current.mode = mode.into();
                    }
                    "session_title_changed" => {
                        let title = text(event, "title")?;
                        if normalize_title(title).as_deref() != Some(title) {
                            return Err(invalid("invalid session title"));
                        }
                        loaded.title = Some(title.into());
                    }
                    _ => {}
                }
                loaded.events.push(event.clone());
            }
        }
    }
    if loaded.title.is_none() {
        loaded.title = loaded
            .events
            .iter()
            .find_map(|event| match event["type"].as_str() {
                Some("user_message") => normalize_title(event["text"].as_str().unwrap_or(""))
                    .or_else(|| match event["imageCount"].as_u64().unwrap_or(0) {
                        0 => None,
                        1 => Some("Image".into()),
                        n => Some(format!("{n} images")),
                    }),
                Some("shell_finished") => normalize_title(event["input"].as_str().unwrap_or("")),
                _ => None,
            });
    }
    Ok(loaded)
}

pub fn normalize_title(text: &str) -> Option<String> {
    let line = text.split(['\r', '\n']).find_map(|line| {
        let line = line
            .chars()
            .map(|c| {
                if c.is_control() || c == '\u{feff}' {
                    ' '
                } else {
                    c
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        (!line.is_empty()).then_some(line)
    })?;
    if line.chars().count() <= 80 {
        return Some(line);
    }
    Some(format!(
        "{}…",
        line.chars().take(79).collect::<String>().trim_end()
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub path: PathBuf,
    pub cwd: String,
    pub title: String,
    pub messages: usize,
    pub updated_at: u64,
}

pub fn list(directory: &Path) -> io::Result<Vec<Summary>> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if !directory
                .join(format!("{}.jsonl", entry.file_name().to_string_lossy()))
                .is_file()
            {
                result.extend(list(&entry.path())?);
            }
            continue;
        }
        if !entry.file_type()?.is_file() || entry.path().extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        let loaded = load(&entry.path())?;
        if loaded
            .events
            .iter()
            .all(|e| e["type"] != "user_message" && e["type"] != "shell_finished")
        {
            continue;
        }
        result.push(Summary {
            id: loaded.meta.id,
            path: entry.path(),
            cwd: loaded.meta.cwd,
            title: loaded.title.unwrap_or_else(|| "(empty prompt)".into()),
            messages: loaded.conversation.checkpoints.len(),
            updated_at: entry
                .metadata()?
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_millis()
                .try_into()
                .map_err(io::Error::other)?,
        });
    }
    result.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(result)
}

pub fn find(directory: &Path, id: &str) -> io::Result<Summary> {
    let entries = list(directory)?;
    if let Some(index) = entries.iter().position(|e| e.id == id) {
        return entries
            .into_iter()
            .nth(index)
            .ok_or_else(|| invalid("session disappeared"));
    }
    let mut matches = entries.into_iter().filter(|e| e.id.starts_with(id));
    let found = matches
        .next()
        .ok_or_else(|| invalid(format!("unknown session: {id}")))?;
    if matches.next().is_some() {
        return Err(invalid(format!("ambiguous session prefix: {id}")));
    }
    Ok(found)
}

pub fn text<'a>(value: &'a Value, field: &str) -> io::Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("invalid session {field}")))
}

fn optional_text(value: &Value, field: &str) -> io::Result<Option<String>> {
    value
        .get(field)
        .map(|_| text(value, field).map(str::to_owned))
        .transpose()
}

fn invalid_json(error: serde_json::Error) -> io::Error {
    invalid(error.to_string())
}
