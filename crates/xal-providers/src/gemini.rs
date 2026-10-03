use serde_json::{Value, json};
use xal_host::*;

use crate::{Id, count, invalid, replay, replay_of, string};

pub(crate) fn body(request: &ProviderRequest) -> Result<Value> {
    let mut contents: Vec<Value> = Vec::new();
    for item in &request.input {
        let (role, parts) = match item {
            Item::UserMessage {
                text,
                model_text,
                images,
                ..
            } => {
                let mut parts = Vec::new();
                for attachment in images {
                    let (media, data) = crate::image(attachment)?;
                    parts.push(json!({"inlineData":{"mimeType":media,"data":data}}));
                }
                parts.push(json!({"text":model_text.as_ref().unwrap_or(text)}));
                ("user", parts)
            }
            Item::Reasoning { .. } => (
                "model",
                replay(item, Id::Google, &request.model)
                    .into_iter()
                    .collect(),
            ),
            Item::AssistantMessage { text, .. } => (
                "model",
                vec![
                    replay(item, Id::Google, &request.model)
                        .unwrap_or_else(|| json!({"text":text})),
                ],
            ),
            Item::ToolCall { name, args, .. } => (
                "model",
                vec![
                    replay(item, Id::Google, &request.model)
                        .unwrap_or_else(|| json!({"functionCall":{"name":name,"args":args}})),
                ],
            ),
            Item::ToolResult { call_id, output } => {
                let call = request
                    .input
                    .iter()
                    .find(|i| matches!(i,Item::ToolCall {call_id:id,..} if id == call_id));
                let name = match call {
                    Some(Item::ToolCall { name, .. }) => name,
                    _ => call_id,
                };
                let mut response = json!({"name":name,"response":{"output":output}});
                if let Some(id) = call
                    .and_then(|c| replay(c, Id::Google, &request.model))
                    .and_then(|v| v.pointer("/functionCall/id").cloned())
                {
                    response["id"] = id;
                }
                ("user", vec![json!({"functionResponse":response})])
            }
        };
        if parts.is_empty() {
            continue;
        }
        if let Some(last) = contents.last_mut().filter(|c| c["role"] == role) {
            last["parts"]
                .as_array_mut()
                .ok_or_else(|| invalid("invalid Gemini parts"))?
                .extend(parts);
        } else {
            contents.push(json!({"role":role,"parts":parts}));
        }
    }
    let mut body = json!({"contents":contents,"generationConfig":{"thinkingConfig":thinking(&request.model,request.thinking.as_deref())}});
    if !request.instructions.is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":request.instructions}]});
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":request.tools.iter().map(|t| json!({"name":t.name,"description":t.description,"parameters":t.parameters})).collect::<Vec<_>>()}]);
        body["toolConfig"] = json!({"functionCallingConfig":{"mode":"AUTO"}});
    }
    Ok(body)
}

fn thinking(model: &str, effort: Option<&str>) -> Value {
    let model = model.to_lowercase();
    let family = model.split_once("gemini-3").and_then(|(_, tail)| {
        let tail = if let Some(version) = tail.strip_prefix('.') {
            let (minor, rest) = version.split_once('-')?;
            if minor.is_empty() || !minor.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            rest
        } else {
            tail.strip_prefix('-')?
        };
        Some(tail)
    });
    let modern =
        family.is_some() || ["gemini-flash-latest", "gemini-pro-latest"].contains(&model.as_str());
    let pro = family.is_some_and(|tail| tail.starts_with("pro"));
    let effort = effort.unwrap_or("high");
    if !modern {
        if effort == "none" {
            return json!({"thinkingBudget":0});
        }
        return json!({"thinkingBudget":match effort {"low"=>4096,"medium"=>8192,"high"=>16384,_=>24576},"includeThoughts":true});
    }
    json!({"thinkingLevel":match effort {"none" if pro => "LOW","none" => "MINIMAL","low" => "LOW","medium" if !pro => "MEDIUM",_=>"HIGH"},"includeThoughts":effort != "none"})
}

#[derive(Default)]
pub(crate) struct Decoder {
    pending: Option<Value>,
    finish: Option<String>,
    pub usage: Option<Usage>,
}
impl Decoder {
    fn flush(&mut self, model: &str) -> Result<Option<ProviderEvent>> {
        let Some(part) = self.pending.take() else {
            return Ok(None);
        };
        let text = string(&part, "text")?.to_owned();
        let replay = replay_of(Id::Google, model, &part)?;
        Ok(Some(ProviderEvent::Item(if part["thought"] == true {
            Item::Reasoning {
                summary: text,
                replay,
            }
        } else {
            Item::AssistantMessage { text, replay }
        })))
    }
    pub fn push(&mut self, model: &str, data: &str) -> Result<Vec<ProviderEvent>> {
        if data == "[DONE]" {
            return Ok(Vec::new());
        }
        let raw: Value = serde_json::from_str(data).map_err(|_| invalid("invalid Gemini event"))?;
        if let Some(u) = raw.get("usageMetadata") {
            self.usage = Some(Usage {
                total_input_tokens: count(u.get("promptTokenCount"))?,
                cache_read_input_tokens: count(u.get("cachedContentTokenCount"))?,
                cache_write_input_tokens: None,
                output_tokens: Some(
                    count(u.get("candidatesTokenCount"))?
                        .unwrap_or(0)
                        .saturating_add(count(u.get("thoughtsTokenCount"))?.unwrap_or(0)),
                ),
            });
        }
        if let Some(error) = raw.get("error") {
            return Err(crate::provider_error(
                string(error, "message")?.into(),
                ["UNAVAILABLE", "INTERNAL", "DEADLINE", "EXHAUSTED"]
                    .iter()
                    .any(|s| error.to_string().contains(s)),
            ));
        }
        if let Some(reason) = raw
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
        {
            self.finish = Some(reason.into());
        }
        let mut events = Vec::new();
        let Some(parts) = raw.pointer("/candidates/0/content/parts") else {
            return Ok(events);
        };
        for part in parts
            .as_array()
            .ok_or_else(|| invalid("invalid Gemini parts"))?
        {
            if let Some(call) = part.get("functionCall") {
                events.extend(self.flush(model)?);
                let name = string(call, "name")?;
                if name.is_empty() {
                    return Err(invalid("Gemini function has no name"));
                }
                let call_id = match call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                {
                    Some(id) => id.into(),
                    None => xal_services::credentials::new_id().map_err(crate::failure)?,
                };
                events.push(ProviderEvent::Item(Item::ToolCall {
                    call_id,
                    name: name.into(),
                    args: crate::object(call.get("args").cloned().unwrap_or_else(|| json!({})))?,
                    replay: replay_of(Id::Google, model, part)?,
                }));
                continue;
            }
            let Some(text) = part.get("text").and_then(Value::as_str) else {
                continue;
            };
            if self
                .pending
                .as_ref()
                .is_some_and(|p| (p["thought"] == true) != (part["thought"] == true))
            {
                events.extend(self.flush(model)?);
            }
            if let Some(pending) = &mut self.pending {
                pending["text"] = json!(format!("{}{text}", string(pending, "text")?));
                if let Some(signature) = part.get("thoughtSignature") {
                    pending["thoughtSignature"] = signature.clone();
                }
            } else {
                self.pending = Some(part.clone());
            }
            events.push(if part["thought"] == true {
                ProviderEvent::ReasoningSummaryDelta(text.into())
            } else {
                ProviderEvent::TextDelta(text.into())
            });
        }
        Ok(events)
    }
    pub fn finish(&mut self, model: &str) -> Result<Vec<ProviderEvent>> {
        if self.finish.as_deref() != Some("STOP") {
            return Err(crate::provider_error(
                format!(
                    "Gemini stopped before finishing ({})",
                    self.finish.as_deref().unwrap_or("missing finish reason")
                ),
                self.finish.is_none(),
            ));
        }
        let mut events: Vec<_> = self.flush(model)?.into_iter().collect();
        events.push(ProviderEvent::Done {
            usage: self.usage.clone(),
        });
        Ok(events)
    }
}
