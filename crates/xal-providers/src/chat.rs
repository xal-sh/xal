use std::collections::BTreeMap;

use serde_json::{Value, json};
use xal_host::*;

use crate::{Id, count, invalid, object, replay_of, string};

pub(crate) fn body(id: Id, request: &ProviderRequest) -> Result<Value> {
    let mut messages = vec![json!({"role":"system","content":request.instructions})];
    let mut assistant: Option<Value> = None;
    for item in &request.input {
        if matches!(item, Item::UserMessage { .. } | Item::ToolResult { .. })
            && let Some(value) = assistant.take()
        {
            messages.push(value);
        }
        match item {
            Item::UserMessage {
                text,
                model_text,
                images,
                ..
            } => {
                let text = model_text.as_ref().unwrap_or(text);
                let content = if images.is_empty() {
                    json!(text)
                } else {
                    let mut blocks = vec![json!({"type":"text","text":text})];
                    for attachment in images {
                        let (media, data) = crate::image(attachment)?;
                        blocks.push(json!({"type":"image_url","image_url":{"url":format!("data:{media};base64,{data}")}}));
                    }
                    json!(blocks)
                };
                messages.push(json!({"role":"user","content":content}));
            }
            Item::ToolResult { call_id, output } => {
                messages.push(json!({"role":"tool","tool_call_id":call_id,"content":output}))
            }
            Item::AssistantMessage { text, .. } | Item::Reasoning { summary: text, .. } => {
                let message =
                    assistant.get_or_insert_with(|| json!({"role":"assistant","content":""}));
                let key = if matches!(item, Item::Reasoning { .. }) {
                    "reasoning_content"
                } else {
                    "content"
                };
                let previous = message[key].as_str().unwrap_or("");
                message[key] = json!(if previous.is_empty() {
                    text.clone()
                } else {
                    format!("{previous}\n\n{text}")
                });
            }
            Item::ToolCall {
                call_id,
                name,
                args,
                ..
            } => {
                let message =
                    assistant.get_or_insert_with(|| json!({"role":"assistant","content":""}));
                if message.get("tool_calls").is_none() {
                    message["tool_calls"] = json!([]);
                }
                message["tool_calls"].as_array_mut().ok_or_else(|| invalid("invalid tool calls"))?.push(json!({"id":call_id,"type":"function","function":{"name":name,"arguments":serde_json::to_string(args).map_err(crate::failure)?}}));
            }
        }
    }
    if let Some(value) = assistant {
        messages.push(value);
    }
    let mut body = json!({"model":request.model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    let effort = request.thinking.as_deref();
    match id {
        Id::DeepSeek => {
            body["user_id"] = json!(request.session_id);
            body["thinking"] =
                json!({"type":if effort == Some("none") {"disabled"} else {"enabled"}});
            if effort != Some("none") {
                body["reasoning_effort"] = json!(match effort {
                    Some("low") => "low",
                    Some("max") => "max",
                    _ => "high",
                });
            }
        }
        Id::Alibaba => {
            if let Some(effort) = effort {
                body["enable_thinking"] = json!(effort != "none");
            }
        }
        Id::OpenRouter => {
            body["usage"] = json!({"include":true});
            if let Some(effort) = effort {
                body["reasoning"] = if effort == "none" {
                    json!({"enabled":false})
                } else {
                    json!({"effort":if ["xhigh","max"].contains(&effort) {"high"} else {effort}})
                };
            }
        }
        Id::Copilot => {
            if let Some(effort) = effort.filter(|v| *v != "none") {
                body["reasoning_effort"] = json!(effort);
            }
        }
        Id::Go => {}
        _ => return Err(invalid("provider does not use Chat Completions")),
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools.iter().map(|t| json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}})).collect::<Vec<_>>());
        body["tool_choice"] = json!("auto");
    }
    Ok(body)
}

#[derive(Default)]
pub(crate) struct Decoder {
    text: String,
    reasoning: String,
    calls: BTreeMap<u64, (String, String, String)>,
    finish: Option<String>,
    pub usage: Option<Usage>,
}

impl Decoder {
    pub fn push(&mut self, id: Id, model: &str, data: &str) -> Result<Vec<ProviderEvent>> {
        if data == "[DONE]" {
            return self.finish(id, model);
        }
        let raw: Value =
            serde_json::from_str(data).map_err(|_| invalid("invalid Chat Completions event"))?;
        if let Some(usage) = raw.get("usage").filter(|v| !v.is_null()) {
            if !usage.is_object() {
                return Err(invalid("invalid provider usage"));
            }
            self.usage = Some(Usage {
                total_input_tokens: count(usage.get("prompt_tokens"))?,
                cache_read_input_tokens: count(
                    usage
                        .get("prompt_cache_hit_tokens")
                        .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens")),
                )?,
                output_tokens: count(usage.get("completion_tokens"))?,
                cache_write_input_tokens: None,
            });
        }
        if let Some(error) = raw.get("error") {
            return Err(crate::provider_error(
                string(error, "message")?.into(),
                true,
            ));
        }
        let Some(choice) = raw.pointer("/choices/0") else {
            return Ok(Vec::new());
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish = Some(reason.into());
        }
        let delta = &choice["delta"];
        let mut events = Vec::new();
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.text.push_str(text);
            events.push(ProviderEvent::TextDelta(text.into()));
        }
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            self.reasoning.push_str(text);
            events.push(ProviderEvent::ReasoningSummaryDelta(text.into()));
        }
        if let Some(calls) = delta.get("tool_calls") {
            for call in calls
                .as_array()
                .ok_or_else(|| invalid("invalid streamed tool calls"))?
            {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .filter(|i| *i < 4096)
                    .ok_or_else(|| invalid("invalid tool call index"))?;
                let pending = self.calls.entry(index).or_default();
                if let Some(value) = call.get("id").and_then(Value::as_str) {
                    pending.0.push_str(value);
                }
                if let Some(value) = call.pointer("/function/name").and_then(Value::as_str) {
                    pending.1.push_str(value);
                }
                if let Some(value) = call.pointer("/function/arguments").and_then(Value::as_str) {
                    pending.2.push_str(value);
                }
            }
        }
        Ok(events)
    }

    fn finish(&mut self, id: Id, model: &str) -> Result<Vec<ProviderEvent>> {
        match self.finish.as_deref() {
            Some("stop" | "tool_calls" | "function_call") => {}
            Some("insufficient_system_resource") if id == Id::DeepSeek => {
                return Err(crate::provider_error(
                    "DeepSeek had insufficient capacity to complete the response".into(),
                    true,
                ));
            }
            Some(reason) => {
                return Err(invalid(&format!(
                    "{} response did not complete ({reason})",
                    id.as_str()
                )));
            }
            None => {
                return Err(invalid(
                    "Chat Completions stream ended without a finish reason",
                ));
            }
        }
        let mut events = Vec::new();
        if !self.reasoning.is_empty() {
            events.push(ProviderEvent::Item(Item::Reasoning {
                summary: self.reasoning.clone(),
                replay: replay_of(id, model, &json!({"reasoning_content":self.reasoning}))?,
            }));
        }
        events.push(ProviderEvent::Item(Item::AssistantMessage {
            text: self.text.clone(),
            replay: replay_of(id, model, &json!({"content":self.text}))?,
        }));
        for (call_id, name, args) in self.calls.values() {
            if call_id.is_empty() || name.is_empty() {
                return Err(invalid("incomplete tool call"));
            }
            let arguments = object(
                serde_json::from_str(args).map_err(|_| invalid("invalid JSON tool arguments"))?,
            )?;
            events.push(ProviderEvent::Item(Item::ToolCall { call_id: call_id.clone(), name: name.clone(), args: arguments, replay: replay_of(id, model, &json!({"id":call_id,"type":"function","function":{"name":name,"arguments":args}}))? }));
        }
        events.push(ProviderEvent::Done {
            usage: self.usage.clone(),
        });
        Ok(events)
    }
}
