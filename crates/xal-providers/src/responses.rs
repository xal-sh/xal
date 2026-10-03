use serde_json::{Value, json};
use xal_host::*;

use super::{Id, count, provider_error};

pub fn body(id: Id, request: &ProviderRequest) -> Result<Value> {
    let mut input = Vec::new();
    for item in &request.input {
        if id == Id::Xai && matches!(item, Item::Reasoning { .. }) {
            continue;
        }
        let replay = match item {
            Item::AssistantMessage { replay, .. }
            | Item::Reasoning { replay, .. }
            | Item::ToolCall { replay, .. } => replay.as_ref().filter(|replay| {
                replay.provider == id.as_str()
                    && replay
                        .model
                        .as_deref()
                        .is_none_or(|model| model == request.model)
            }),
            Item::UserMessage { .. } | Item::ToolResult { .. } => None,
        };
        if let Some(replay) = replay {
            input.push(Value::Object(replay.data.clone()));
            continue;
        }
        match item {
            Item::UserMessage { text, images, model_text, .. } => {
                let text = model_text.as_ref().unwrap_or(text);
                let mut content = vec![json!({"type":"input_text","text":text})];
                for attachment in images {
                    let (media, data) = super::image(attachment)?;
                    content.push(json!({"type":"input_image","image_url":format!("data:{media};base64,{data}")}));
                }
                input.push(json!({"role":"user","content":content}));
            }
            Item::AssistantMessage { text, .. } => input.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]})),
            Item::Reasoning { .. } => {},
            Item::ToolCall { call_id, name, args, .. } => input.push(json!({"type":"function_call","call_id":call_id,"name":name,"arguments":serde_json::to_string(args).map_err(|error| Error::Failed(error.to_string()))?})),
            Item::ToolResult { call_id, output } => input.push(json!({"type":"function_call_output","call_id":call_id,"output":output})),
        }
    }
    let mut body = json!({"model":request.model,"store":false,"stream":true,"instructions":request.instructions,"input":input,"prompt_cache_key":request.cache_key});
    if let Some(effort) = &request.thinking {
        body["reasoning"] = if effort == "none" {
            json!({"effort":effort})
        } else {
            json!({"effort":effort,"summary":"auto"})
        };
        if effort != "none" {
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools.iter().map(|tool| json!({"type":"function","name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":false})).collect());
        body["tool_choice"] = json!("auto");
        body["parallel_tool_calls"] = json!(true);
    }
    match id {
        Id::ChatGpt => {
            let model = request
                .model
                .strip_suffix("-fast")
                .unwrap_or(&request.model);
            body["model"] = json!(model.strip_suffix("-1m").unwrap_or(model));
            if request.model.ends_with("-fast") {
                body["service_tier"] = json!("priority");
            }
            body["reasoning"] =
                json!({"effort":request.thinking.as_deref().unwrap_or("medium"),"summary":"auto"});
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
        Id::OpenAi => {
            body["model"] = json!(request.model.strip_suffix("-1m").unwrap_or(&request.model));
        }
        Id::Xai => {
            let map = body
                .as_object_mut()
                .ok_or_else(|| super::invalid("invalid request body"))?;
            map.remove("include");
            map.remove("parallel_tool_calls");
            if request.thinking.as_deref().is_none_or(|v| v == "none")
                || !super::catalog::xai_effort(&request.model)
            {
                map.remove("reasoning");
            } else {
                map.insert("reasoning".into(), json!({"effort":if request.thinking.as_deref() == Some("max") { "xhigh" } else { request.thinking.as_deref().unwrap_or("high") }}));
            }
            if let Some(Value::Array(tools)) = map.get_mut("tools") {
                for tool in tools {
                    if let Some(map) = tool.as_object_mut() {
                        map.remove("strict");
                    }
                }
            }
        }
        Id::Copilot => {
            body["reasoning"] =
                json!({"effort":request.thinking.as_deref().unwrap_or("medium"),"summary":"auto"});
            body["include"] = json!(["reasoning.encrypted_content"]);
            body.as_object_mut()
                .ok_or_else(|| super::invalid("invalid request body"))?
                .remove("prompt_cache_key");
        }
        Id::Go => {
            body.as_object_mut()
                .ok_or_else(|| super::invalid("invalid request body"))?
                .remove("prompt_cache_key");
        }
        Id::Anthropic
        | Id::Google
        | Id::DeepSeek
        | Id::Alibaba
        | Id::OpenRouter
        | Id::MiniMax
        | Id::MiniMaxPlan
        | Id::TypeSafe => return Err(super::invalid("provider does not use Responses")),
    }
    Ok(body)
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| provider_error(format!("provider response has invalid {field}"), false))
}

fn blocks(value: &Value, field: &str, kind: &str) -> Result<String> {
    let blocks = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| provider_error("response message content was not an array".into(), false))?;
    let mut text = String::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some(kind) {
            text.push_str(string(block, "text")?);
        }
        if block.get("type").and_then(Value::as_str) == Some("refusal") {
            text.push_str(string(block, "refusal")?);
        }
    }
    Ok(text)
}

pub fn event(id: Id, data: &str, model: &str) -> Result<Option<ProviderEvent>> {
    if data == "[DONE]" {
        return Ok(None);
    }
    let raw: Value = serde_json::from_str(data)
        .map_err(|_| provider_error("provider SSE event was not valid JSON".into(), false))?;
    match string(&raw, "type")? {
        "response.output_text.delta" => Ok(Some(ProviderEvent::TextDelta(
            string(&raw, "delta")?.into(),
        ))),
        "response.reasoning_summary_text.delta" => Ok(Some(ProviderEvent::ReasoningSummaryDelta(
            string(&raw, "delta")?.into(),
        ))),
        "response.reasoning_text.delta" => Ok(Some(if id == Id::Xai {
            ProviderEvent::ReasoningSummaryDelta(string(&raw, "delta")?.into())
        } else {
            ProviderEvent::ReasoningDelta(string(&raw, "delta")?.into())
        })),
        "response.output_item.done" => {
            let data = raw
                .get("item")
                .and_then(Value::as_object)
                .ok_or_else(|| provider_error("response item was not valid JSON".into(), false))?
                .clone();
            let value = Value::Object(data.clone());
            let replay = Some(Replay {
                provider: id.as_str().into(),
                model: Some(model.into()),
                data,
            });
            let item = match string(&value, "type")? {
                "message" => {
                    if string(&value, "role")? != "assistant" {
                        return Err(provider_error(
                            "response message had an invalid role".into(),
                            false,
                        ));
                    }
                    Item::AssistantMessage {
                        text: blocks(&value, "content", "output_text")?,
                        replay,
                    }
                }
                "reasoning" => Item::Reasoning {
                    summary: blocks(&value, "summary", "summary_text")?,
                    replay: if id == Id::Xai { None } else { replay },
                },
                "function_call" => {
                    let call_id = string(&value, "call_id")?.to_owned();
                    let name = string(&value, "name")?.to_owned();
                    if call_id.is_empty() || name.is_empty() {
                        return Err(provider_error(
                            "response tool call was incomplete".into(),
                            false,
                        ));
                    }
                    let args = serde_json::from_str::<JsonObject>(string(&value, "arguments")?)
                        .map_err(|_| {
                            provider_error(
                                format!("provider tool call {name} had invalid JSON arguments"),
                                false,
                            )
                        })?;
                    Item::ToolCall {
                        call_id,
                        name,
                        args,
                        replay,
                    }
                }
                _ => return Ok(None),
            };
            Ok(Some(ProviderEvent::Item(item)))
        }
        "response.completed" | "response.done" => {
            let response = raw.get("response").ok_or_else(|| {
                provider_error("provider completion has no response".into(), false)
            })?;
            let status = string(response, "status")?;
            if status != "completed" {
                return Err(provider_error(
                    format!("provider response did not complete ({status})"),
                    false,
                ));
            }
            let usage = response.get("usage").filter(|usage| !usage.is_null());
            if usage.is_some_and(|usage| !usage.is_object()) {
                return Err(provider_error(
                    "invalid provider usage object".into(),
                    false,
                ));
            }
            let usage = usage
                .map(|usage| -> Result<Usage> {
                    Ok(Usage {
                        total_input_tokens: count(usage.get("input_tokens"))?,
                        output_tokens: count(usage.get("output_tokens"))?,
                        cache_read_input_tokens: count(
                            usage.pointer("/input_tokens_details/cached_tokens"),
                        )?,
                        cache_write_input_tokens: count(
                            usage.pointer("/input_tokens_details/cache_write_tokens"),
                        )?,
                    })
                })
                .transpose()?;
            Ok(Some(ProviderEvent::Done { usage }))
        }
        "response.incomplete" => Err(provider_error(
            format!(
                "response incomplete: {}",
                raw.pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown reason")
            ),
            false,
        )),
        "response.failed" | "error" => {
            let error = raw
                .pointer("/response/error")
                .or_else(|| raw.get("error"))
                .unwrap_or(&raw);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider stream error");
            let code = error.get("code").and_then(Value::as_str).unwrap_or("");
            let transient = format!("{code} {message}").to_lowercase();
            Err(provider_error(
                message.into(),
                [
                    "overloaded",
                    "rate_limit",
                    "rate limit",
                    "server_error",
                    "internal_error",
                    "service_unavailable",
                    "timeout",
                    "try again",
                ]
                .iter()
                .any(|word| transient.contains(word)),
            ))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_replay_is_model_bound_and_requests_remain_responses_native() {
        let item = event(Id::OpenAi, &json!({"type":"response.output_item.done","item":{"type":"reasoning","id":"reason","summary":[{"type":"summary_text","text":"thought"}],"encrypted_content":"opaque"}}).to_string(), "gpt-5").unwrap().unwrap();
        let ProviderEvent::Item(item) = item else {
            panic!("missing reasoning item");
        };
        assert!(matches!(&item, Item::Reasoning { summary, .. } if summary == "thought"));
        let mut request = ProviderRequest {
            model: "gpt-5".into(),
            instructions: "system".into(),
            input: vec![item],
            profile: None,
            tools: Vec::new(),
            thinking: Some("high".into()),
            cache_key: "session".into(),
            session_id: String::new(),
            phase: xal_host::recording::Phase::Turn,
            attempt: 1,
        };
        let wire = body(Id::OpenAi, &request).unwrap();
        assert_eq!(wire["input"][0]["encrypted_content"], "opaque");
        assert_eq!(wire["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(wire["store"], false);
        request.model = "gpt-4.1".into();
        request.thinking = None;
        let wire = body(Id::OpenAi, &request).unwrap();
        assert_eq!(wire["input"], json!([]));
        assert!(wire.get("reasoning").is_none());
    }

    #[test]
    fn malformed_arguments_and_noncompleted_responses_cannot_become_success() {
        for raw in [
            json!({"type":"response.output_item.done","item":{"type":"function_call","name":"write","call_id":"call","arguments":"[]"}}),
            json!({"type":"response.output_item.done","item":{"type":"function_call","name":"write","call_id":"call","arguments":"{"}}),
            json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
            json!({"type":"response.done","response":{"status":"failed"}}),
            json!({"type":"response.completed","response":{"status":"completed","usage":[]}}),
            json!({"type":"response.completed"}),
        ] {
            assert!(
                event(Id::OpenAi, &raw.to_string(), "gpt-4.1").is_err(),
                "{raw}"
            );
        }
        assert!(matches!(event(Id::OpenAi, &json!({"type":"response.failed","response":{"error":{"code":"server_error","message":"retry"}}}).to_string(), "gpt-4.1"), Err(Error::Provider { retryable: true, .. })));
    }
}
