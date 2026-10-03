use std::collections::BTreeMap;

use serde_json::{Value, json};
use xal_host::*;

use crate::{Id, catalog::Model, count, invalid, replay, replay_of, string};

pub(crate) fn body(id: Id, model: &Model, request: &ProviderRequest) -> Result<Value> {
    let mut messages: Vec<Value> = Vec::new();
    for item in &request.input {
        let (role, blocks) = match item {
            Item::UserMessage {
                text,
                model_text,
                images,
                ..
            } => {
                let mut blocks = Vec::new();
                for attachment in images {
                    let (media, data) = crate::image(attachment)?;
                    blocks.push(json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}}));
                }
                let text = model_text.as_ref().unwrap_or(text);
                if !text.is_empty() {
                    blocks.push(json!({"type":"text","text":text}));
                }
                if blocks.is_empty() {
                    blocks.push(json!({"type":"text","text":"(empty message)"}));
                }
                ("user", blocks)
            }
            Item::ToolResult { call_id, output } => (
                "user",
                vec![json!({"type":"tool_result","tool_use_id":call_id,"content":output})],
            ),
            Item::Reasoning { .. } => (
                "assistant",
                replay(item, id, &request.model).into_iter().collect(),
            ),
            Item::AssistantMessage { text, .. } => (
                "assistant",
                replay(item, id, &request.model)
                    .or_else(|| (!text.is_empty()).then(|| json!({"type":"text","text":text})))
                    .into_iter()
                    .collect(),
            ),
            Item::ToolCall {
                call_id,
                name,
                args,
                ..
            } => (
                "assistant",
                vec![replay(item, id, &request.model).unwrap_or_else(
                    || json!({"type":"tool_use","id":call_id,"name":name,"input":args}),
                )],
            ),
        };
        if blocks.is_empty() {
            continue;
        }
        if let Some(last) = messages.last_mut().filter(|last| last["role"] == role) {
            last["content"]
                .as_array_mut()
                .ok_or_else(|| invalid("invalid message content"))?
                .extend(blocks);
        } else {
            messages.push(json!({"role":role,"content":blocks}));
        }
    }
    if let Some(block) = messages
        .last_mut()
        .and_then(|m| m["content"].as_array_mut())
        .and_then(|c| c.last_mut())
    {
        block["cache_control"] = json!({"type":"ephemeral"});
    }
    let mut body = json!({"model":request.model,"max_tokens":model.max_output_tokens.unwrap_or(32_000),"stream":true,"system":[{"type":"text","text":request.instructions,"cache_control":{"type":"ephemeral"}}],"messages":messages});
    let effort = request.thinking.as_deref().unwrap_or("high");
    match id {
        Id::Anthropic => {
            body["thinking"] = if effort == "none" {
                json!({"type":"disabled"})
            } else if crate::catalog::budget_thinking(&request.model) {
                let tokens = match effort {
                    "low" => 4096,
                    "medium" => 8192,
                    "high" => 16384,
                    "xhigh" => 24576,
                    _ => 32768,
                };
                json!({"type":"enabled","budget_tokens":tokens.min(model.max_output_tokens.unwrap_or(32_000).saturating_sub(1024))})
            } else {
                body["output_config"] = json!({"effort":effort});
                json!({"type":"adaptive","display":"summarized"})
            };
        }
        Id::MiniMax | Id::MiniMaxPlan | Id::Go => {
            let name = request.model.to_lowercase();
            if name.contains("minimax-m3") {
                body["thinking"] =
                    json!({"type":if effort == "none" {"disabled"} else {"adaptive"}});
            } else if id != Id::Go && name.contains("minimax-m2") {
                body["temperature"] = json!(1);
                body["top_p"] = json!(0.95);
                body["top_k"] = json!(if ["m2.", "m25", "m21"].iter().any(|s| name.contains(s)) {
                    40
                } else {
                    20
                });
            }
        }
        _ => return Err(invalid("provider does not use Messages")),
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools.iter().map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.parameters})).collect::<Vec<_>>());
        body["tool_choice"] = json!({"type":"auto"});
    }
    Ok(body)
}

#[derive(Default)]
pub(crate) struct Decoder {
    blocks: BTreeMap<u64, (Value, String)>,
    stop: Option<String>,
    pub usage: Option<Usage>,
}

impl Decoder {
    pub fn push(&mut self, id: Id, model: &str, data: &str) -> Result<Vec<ProviderEvent>> {
        if data == "[DONE]" {
            return Ok(Vec::new());
        }
        let raw: Value =
            serde_json::from_str(data).map_err(|_| invalid("invalid Messages event"))?;
        let mut events = Vec::new();
        match string(&raw, "type")? {
            "message_start" => {
                if let Some(u) = raw.pointer("/message/usage") {
                    let read = count(u.get("cache_read_input_tokens"))?.unwrap_or(0);
                    let write = count(u.get("cache_creation_input_tokens"))?.unwrap_or(0);
                    self.usage = Some(Usage {
                        total_input_tokens: Some(
                            count(u.get("input_tokens"))?
                                .unwrap_or(0)
                                .saturating_add(read)
                                .saturating_add(write),
                        ),
                        cache_read_input_tokens: Some(read),
                        cache_write_input_tokens: Some(write),
                        output_tokens: count(u.get("output_tokens"))?,
                    });
                }
            }
            "content_block_start" => {
                let index = index(&raw)?;
                let block = raw
                    .get("content_block")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| invalid("invalid Messages block"))?;
                if self
                    .blocks
                    .insert(index, (block.clone(), String::new()))
                    .is_some()
                {
                    return Err(invalid("duplicate Messages block"));
                }
            }
            "content_block_delta" => {
                let block = self
                    .blocks
                    .get_mut(&index(&raw)?)
                    .ok_or_else(|| invalid("Messages delta without a block"))?;
                let delta = &raw["delta"];
                let (field, value, event) = match string(delta, "type")? {
                    "text_delta" => ("text", string(delta, "text")?, Some(false)),
                    "thinking_delta" => ("thinking", string(delta, "thinking")?, Some(true)),
                    "signature_delta" => ("signature", string(delta, "signature")?, None),
                    "input_json_delta" => {
                        block.1.push_str(string(delta, "partial_json")?);
                        return Ok(events);
                    }
                    _ => return Ok(events),
                };
                let mut text = block.0[field].as_str().unwrap_or("").to_owned();
                text.push_str(value);
                block.0[field] = json!(text);
                if let Some(thought) = event {
                    events.push(if thought {
                        ProviderEvent::ReasoningSummaryDelta(value.into())
                    } else {
                        ProviderEvent::TextDelta(value.into())
                    });
                }
            }
            "content_block_stop" => {
                let (mut block, args) = self
                    .blocks
                    .remove(&index(&raw)?)
                    .ok_or_else(|| invalid("Messages stop without a block"))?;
                if block["type"] == "tool_use" && !args.trim().is_empty() {
                    block["input"] = serde_json::from_str(&args)
                        .map_err(|_| invalid("invalid JSON tool arguments"))?;
                }
                let replay = replay_of(id, model, &block)?;
                let item = match string(&block, "type")? {
                    "text" => Item::AssistantMessage {
                        text: string(&block, "text")?.into(),
                        replay,
                    },
                    "thinking" => Item::Reasoning {
                        summary: string(&block, "thinking")?.into(),
                        replay,
                    },
                    "redacted_thinking" => Item::Reasoning {
                        summary: String::new(),
                        replay,
                    },
                    "tool_use" => {
                        let call_id = string(&block, "id")?;
                        let name = string(&block, "name")?;
                        if call_id.is_empty() || name.is_empty() {
                            return Err(invalid("incomplete tool call"));
                        }
                        Item::ToolCall {
                            call_id: call_id.into(),
                            name: name.into(),
                            args: crate::object(block["input"].clone())?,
                            replay,
                        }
                    }
                    _ => return Ok(events),
                };
                events.push(ProviderEvent::Item(item));
            }
            "message_delta" => {
                self.stop = raw
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(output) = count(raw.pointer("/usage/output_tokens"))? {
                    self.usage.get_or_insert_default().output_tokens = Some(output);
                }
            }
            "message_stop" => {
                if !self.blocks.is_empty() {
                    return Err(invalid("Messages stream ended within a block"));
                }
                match self.stop.as_deref() {
                    Some("end_turn" | "tool_use" | "stop_sequence" | "pause_turn") => {}
                    _ => {
                        return Err(invalid(&format!(
                            "{} stopped before finishing ({})",
                            id.as_str(),
                            self.stop.as_deref().unwrap_or("missing stop reason")
                        )));
                    }
                }
                events.push(ProviderEvent::Done {
                    usage: self.usage.clone(),
                });
            }
            "error" => {
                let detail = string(&raw["error"], "message")?;
                return Err(crate::provider_error(
                    detail.into(),
                    ["overloaded", "rate_limit", "api_error", "timeout"]
                        .iter()
                        .any(|s| raw.to_string().contains(s)),
                ));
            }
            _ => {}
        }
        Ok(events)
    }
}
fn index(raw: &Value) -> Result<u64> {
    raw.get("index")
        .and_then(Value::as_u64)
        .filter(|i| *i < 4096)
        .ok_or_else(|| invalid("invalid Messages block index"))
}
