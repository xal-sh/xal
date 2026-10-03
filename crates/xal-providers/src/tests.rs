mod accounts;
mod streaming;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use xal_host::*;
use xal_services::{
    credentials::{Change, Credential, Credentials},
    redactor::Redactor,
    settings::Settings,
    storage,
};

use super::*;
use client::{Account, Client};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xal-providers-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn new(replies: Vec<(u16, String, Duration)>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let collected = requests.clone();
        let task = tokio::spawn(async move {
            for (status, reply, delay) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (header, start, length) = loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (header, end + 4, length);
                    }
                };
                while bytes.len() < start + length {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                collected.lock().unwrap().push((
                    header,
                    String::from_utf8(bytes[start..start + length].to_vec()).unwrap(),
                ));
                tokio::time::sleep(delay).await;
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
    async fn wait_for(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.requests.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn settings() -> Settings {
    Settings::parse(&JsonObject::new()).unwrap()
}
fn client(id: Id) -> Client {
    Client::new(
        id,
        Account::Fixed(Credential::ApiKey {
            key: "fixture-key".into(),
        }),
        &settings(),
        Arc::new(Redactor::new(Vec::new()).unwrap()),
    )
    .unwrap()
}
fn request(model: &str) -> ProviderRequest {
    ProviderRequest {
        model: model.into(),
        instructions: "instructions".into(),
        input: vec![Item::user("question".into())],
        profile: None,
        tools: vec![ToolDefinition {
            name: "read".into(),
            description: "Read a file".into(),
            parameters: json!({"type":"object"}).as_object().unwrap().clone(),
        }],
        thinking: Some("high".into()),
        cache_key: "cache-identity".into(),
        session_id: "session-identity".into(),
        phase: recording::Phase::Turn,
        attempt: 1,
    }
}
fn output(events: Vec<ProviderEvent>) -> Vec<Item> {
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::Done { .. }))
    );
    events
        .into_iter()
        .filter_map(|e| match e {
            ProviderEvent::Item(item) => Some(item),
            _ => None,
        })
        .collect()
}
fn result() -> Item {
    Item::ToolResult {
        call_id: "call".into(),
        output: "file contents".into(),
    }
}

#[test]
fn response_providers_round_trip_signed_tool_history_and_aliases() {
    for id in [Id::OpenAi, Id::ChatGpt, Id::Xai, Id::Copilot, Id::Go] {
        let mut request = request(if id == Id::ChatGpt {
            "gpt-5.6-fast"
        } else {
            "gpt-5.6"
        });
        for item in [
            json!({"type":"reasoning","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"opaque"}),
            json!({"type":"function_call","call_id":"call","name":"read","arguments":"{\"file_path\":\"a.rs\"}"}),
        ] {
            let event = responses::event(
                id,
                &json!({"type":"response.output_item.done","item":item}).to_string(),
                &request.model,
            )
            .unwrap()
            .unwrap();
            let ProviderEvent::Item(item) = event else {
                panic!("expected item")
            };
            request.input.push(item);
        }
        request.input.push(result());
        let body = responses::body(id, &request).unwrap();
        assert!(body.to_string().contains("function_call_output"));
        assert_eq!(body.to_string().contains("opaque"), id != Id::Xai);
        if id == Id::ChatGpt {
            assert_eq!(body["service_tier"], "priority");
            assert_eq!(body["model"], "gpt-5.6");
        }
        if id == Id::Xai {
            assert!(body.get("include").is_none());
            assert!(body["tools"][0].get("strict").is_none());
        }
        assert!(matches!(responses::event(id, &json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":8,"output_tokens":2,"input_tokens_details":{"cached_tokens":null}}}}).to_string(), &request.model).unwrap(), Some(ProviderEvent::Done { usage: Some(_) })));
        let portable = xal_host::agent::history::prepare(&request.input, "other", "other", false);
        assert!(
            !responses::body(
                id,
                &ProviderRequest {
                    input: portable,
                    ..request
                }
            )
            .unwrap()
            .to_string()
            .contains("opaque")
        );
    }
}

#[test]
fn chat_providers_merge_deltas_and_replay_tools_with_provider_options() {
    for id in [
        Id::DeepSeek,
        Id::Alibaba,
        Id::OpenRouter,
        Id::Copilot,
        Id::Go,
    ] {
        let mut decoder = chat::Decoder::default();
        decoder.push(id, "model", &json!({"choices":[{"delta":{"reasoning_content":"plan","tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{"}}]}}]}).to_string()).unwrap();
        decoder.push(id, "model", &json!({"choices":[{"delta":{"content":"reading","tool_calls":[{"index":0,"function":{"arguments":"\"file_path\":\"a.rs\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}).to_string()).unwrap();
        let mut request = request("model");
        request
            .input
            .extend(output(decoder.push(id, "model", "[DONE]").unwrap()));
        request.input.push(result());
        let body = chat::body(id, &request).unwrap();
        assert_eq!(body["messages"][2]["reasoning_content"], "plan");
        assert_eq!(body["messages"][2]["tool_calls"][0]["id"], "call");
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(
            decoder.usage.as_ref().unwrap().cache_read_input_tokens,
            Some(2)
        );
        match id {
            Id::DeepSeek => assert_eq!(body["user_id"], "session-identity"),
            Id::Alibaba => assert_eq!(body["enable_thinking"], true),
            Id::OpenRouter => assert_eq!(body["reasoning"]["effort"], "high"),
            Id::Copilot => assert_eq!(body["reasoning_effort"], "high"),
            Id::Go => assert!(body.get("reasoning_effort").is_none()),
            _ => unreachable!(),
        }
        assert!(
            chat::Decoder::default()
                .push(id, "model", "[DONE]")
                .is_err()
        );
    }
}

#[test]
fn messages_providers_retain_signatures_and_handle_cached_usage() {
    for id in [Id::Anthropic, Id::MiniMax, Id::MiniMaxPlan, Id::Go] {
        let mut decoder = messages::Decoder::default();
        let mut events = Vec::new();
        for event in [
            json!({"type":"message_start","message":{"usage":{"input_tokens":8,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call","name":"read","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"a.rs\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ] {
            events.extend(decoder.push(id, "model", &event.to_string()).unwrap());
        }
        let mut request = request("model");
        request.input.extend(output(events));
        request.input.push(result());
        let body = messages::body(
            id,
            &catalog::model_info(id, "model", 260_000).unwrap(),
            &request,
        )
        .unwrap();
        assert_eq!(body["messages"][1]["content"][0]["signature"], "signed");
        assert_eq!(
            body["messages"][1]["content"][1]["input"]["file_path"],
            "a.rs"
        );
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call");
        assert_eq!(decoder.usage.unwrap().total_input_tokens, Some(14));
        request.input.insert(
            1,
            Item::AssistantMessage {
                text: String::new(),
                replay: None,
            },
        );
        assert_eq!(
            messages::body(
                id,
                &catalog::model_info(id, "model", 260_000).unwrap(),
                &request
            )
            .unwrap(),
            body
        );
    }
}

#[test]
fn gemini_replays_signed_thoughts_and_function_ids() {
    let mut decoder = gemini::Decoder::default();
    let mut events = Vec::new();
    for part in [
        json!({"text":"plan","thought":true}),
        json!({"text":"","thought":true,"thoughtSignature":"signed"}),
        json!({"functionCall":{"id":"call","name":"read","args":{"file_path":"a.rs"}},"thoughtSignature":"call-signature"}),
    ] {
        events.extend(
            decoder
                .push(
                    "gemini-3.1-pro",
                    &json!({"candidates":[{"content":{"parts":[part]}}]}).to_string(),
                )
                .unwrap(),
        );
    }
    decoder.push("gemini-3.1-pro", &json!({"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"thoughtsTokenCount":4,"candidatesTokenCount":2}}).to_string()).unwrap();
    events.extend(decoder.finish("gemini-3.1-pro").unwrap());
    let mut request = request("gemini-3.1-pro");
    request.input.extend(output(events));
    request.input.push(result());
    let body = gemini::body(&request).unwrap();
    assert_eq!(
        body["contents"][1]["parts"][0]["thoughtSignature"],
        "signed"
    );
    assert_eq!(
        body["contents"][1]["parts"][1]["thoughtSignature"],
        "call-signature"
    );
    assert_eq!(
        body["contents"][2]["parts"][0]["functionResponse"]["id"],
        "call"
    );
    assert_eq!(decoder.usage.unwrap().output_tokens, Some(6));
    request.model = "gemini-30-pro".into();
    request.thinking = Some("none".into());
    assert_eq!(
        gemini::body(&request).unwrap()["generationConfig"]["thinkingConfig"],
        json!({"thinkingBudget":0})
    );
}

#[test]
fn all_provider_ids_aliases_metadata_and_image_gates_are_consumed() {
    for id in Id::ALL {
        assert_eq!(Id::parse(id.as_str()).unwrap(), id);
    }
    for (alias, id) in [
        ("openai-api", Id::OpenAi),
        ("chatgpt", Id::ChatGpt),
        ("claude", Id::Anthropic),
        ("gemini", Id::Google),
        ("copilot", Id::Copilot),
        ("grok", Id::Xai),
        ("dashscope", Id::Alibaba),
        ("typesafeai", Id::TypeSafe),
    ] {
        assert_eq!(Id::parse(alias).unwrap(), id);
    }
    let models = catalog::parse_models(Id::OpenAi, &json!({"data":[{"id":"GPT-4.1"},{"id":"o3-mini"},{"id":"o3something"},{"id":"gpt-4o-audio-preview"}]}), true, 260_000).unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["GPT-4.1", "o3-mini"]
    );
    for (model, default) in [
        ("GPT-5.4", Some("none")),
        ("gpt-5.4-pro", Some("medium")),
        ("gpt-5.6", Some("medium")),
        ("gpt-4.1", None),
    ] {
        assert_eq!(
            catalog::model_info(Id::OpenAi, model, 260_000)
                .unwrap()
                .thinking
                .map(|t| t.default),
            default.map(str::to_owned)
        );
    }
    assert_eq!(
        catalog::model_info(Id::OpenAi, "O3-mini", 260_000)
            .unwrap()
            .context_window,
        Some(200_000)
    );
    assert_eq!(
        catalog::model_info(Id::OpenAi, "gpt-4.1", 100)
            .unwrap()
            .context_window,
        Some(100)
    );
    for name in [
        "glm-5",
        "kimi-k2.5",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "hy3-preview",
        "qwen3.5-plus",
    ] {
        let model = catalog::model_info(Id::Go, name, 260_000).unwrap();
        assert!(model.context_window.is_some(), "{name}");
        assert!(model.max_output_tokens.is_some());
    }
    let model = catalog::model_info(Id::Go, "qwen3.5-plus", 260_000).unwrap();
    assert_eq!(model.protocol(Id::Go).unwrap(), Protocol::Messages);
    let mut request = request("deepseek-chat");
    request.input = vec![serde_json::from_value(json!({"type":"user_message","text":"image","images":[{"mediaType":"image/png","data":"AA=="}]})).unwrap()];
    assert!(
        client(Id::DeepSeek)
            .body(
                &catalog::model_info(Id::DeepSeek, "deepseek-chat", 260_000).unwrap(),
                &request
            )
            .is_err()
    );
    assert!(
        client(Id::OpenAi)
            .body(
                &catalog::model_info(Id::OpenAi, "gpt-4.1", 260_000).unwrap(),
                &request
            )
            .unwrap()
            .to_string()
            .contains("data:image/png;base64,AA==")
    );
}

#[tokio::test]
async fn validation_uses_nonbillable_routes_and_preserves_provider_headers() {
    let server = Server::new(vec![(200, "{}".into(), Duration::ZERO)]).await;
    let mut connection = client(Id::OpenRouter);
    connection.endpoint = server.url.clone();
    connection
        .validate_key(&Cancellation::default())
        .await
        .unwrap();
    let requests = server.requests.lock().unwrap().clone();
    assert!(requests[0].0.starts_with("GET /key "));
    assert!(requests[0].0.contains("x-title: xal"));
    for id in [Id::Go, Id::Alibaba, Id::MiniMax, Id::MiniMaxPlan] {
        let mut connection = client(id);
        connection.endpoint = "http://127.0.0.1:1".into();
        connection
            .validate_key(&Cancellation::default())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn refresh_is_single_flight_across_clients_and_settles_after_cancellation() {
    let home = Directory::new();
    let profile = profiles::update(
        &home.0,
        Change::Create {
            name: "OAuth".into(),
            provider: "xai".into(),
            credential: Credential::OAuth {
                access: "old-access".into(),
                refresh: "old-refresh".into(),
                expires: 0.0,
                account_id: None,
            },
        },
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let server = Server::new(vec![(
        200,
        json!({"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600})
            .to_string(),
        Duration::from_millis(100),
    )])
    .await;
    let make = || {
        let mut c = Client::new(
            Id::Xai,
            Account::Profile {
                home: home.0.clone(),
                id: profile.id.clone(),
            },
            &settings(),
            Arc::new(Redactor::new(Vec::new()).unwrap()),
        )
        .unwrap();
        c.auth_endpoint = Some(server.url.clone());
        c
    };
    let first = make();
    let second = make();
    let cancel = Cancellation::default();
    let mut operation = Box::pin(first.credential(false, &cancel));
    tokio::select! { _ = &mut operation => panic!("refresh ended early"), () = server.wait_for(1) => {} }
    cancel.cancel();
    drop(operation);
    let credential = second
        .credential(false, &Cancellation::default())
        .await
        .unwrap();
    first.settle_refresh().await.unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert!(
        Credentials::load(&home.0.join("credentials.json"))
            .unwrap()
            .credential("xai", &profile.id)
            .unwrap()
            == Some(&credential)
    );
    assert_eq!(
        second.redactor.redact("new-access new-refresh"),
        "[REDACTED] [REDACTED]"
    );
}

#[tokio::test]
async fn legacy_cache_binding_missing_profiles_and_default_selection() {
    let home = Directory::new();
    let profile = profiles::update(
        &home.0,
        Change::Create {
            name: "Cache".into(),
            provider: "github-copilot".into(),
            credential: Credential::ApiKey {
                key: "fixture-key".into(),
            },
        },
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let server=Server::new(vec![(200,json!({"data":[null,{"id":"hidden"},{"id":"model","name":"Model","model_picker_enabled":true,"supported_endpoints":["/responses"],"capabilities":{"supports":{"tool_calls":true,"vision":true},"limits":{"max_context_window_tokens":128000}}}]}).to_string(),Duration::ZERO)]).await;
    let mut c = Client::new(
        Id::Copilot,
        Account::Profile {
            home: home.0.clone(),
            id: profile.id.clone(),
        },
        &settings(),
        Arc::new(Redactor::new(Vec::new()).unwrap()),
    )
    .unwrap();
    c.endpoint = server.url.clone();
    assert_eq!(
        c.catalog(&home.0, &profile.id, true, &Cancellation::default())
            .await
            .unwrap()
            .source,
        "runtime"
    );
    c.endpoint = "http://127.0.0.1:1".into();
    assert_eq!(
        c.catalog(&home.0, &profile.id, true, &Cancellation::default())
            .await
            .unwrap()
            .source,
        "cache"
    );
    let old = c.load().unwrap();
    profiles::update(
        &home.0,
        Change::Replace {
            provider: "github-copilot".into(),
            id: profile.id.clone(),
            expected: old,
            credential: Credential::ApiKey {
                key: "other-key".into(),
            },
        },
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert!(
        c.catalog(&home.0, &profile.id, false, &Cancellation::default())
            .await
            .is_err()
    );
    assert_eq!(
        catalog::default_model(Id::Anthropic, &[], None).unwrap(),
        "claude-opus-5"
    );
    assert_eq!(
        catalog::default_model(Id::ChatGpt, &[], Some(" override ")).unwrap(),
        "override"
    );
    assert!(c.local_catalog(&home.0, "different").is_err());
    storage::write_json(
        &home.0.join("cache/openai-chatgpt-models-legacy.json"),
        &json!({"models":[{"id":"legacy","name":"Legacy","supportsFast":false}]}),
    )
    .unwrap();
    let chat = Client::new(
        Id::ChatGpt,
        Account::Fixed(Credential::OAuth {
            access: "access".into(),
            refresh: "refresh".into(),
            expires: 0.0,
            account_id: Some("account".into()),
        }),
        &settings(),
        Arc::new(Redactor::new(Vec::new()).unwrap()),
    )
    .unwrap();
    assert_eq!(
        chat.catalog(&home.0, "legacy", false, &Cancellation::default())
            .await
            .unwrap()
            .models[0]
            .input_modalities,
        ["text"]
    );
}

#[test]
fn typesafe_validates_typed_answers_and_exact_question_ids() {
    let request = DecisionRequest {
        model: "jev-latest".into(),
        state: json!({"text":"input"}),
        questions: BTreeMap::from([
            (
                "n".into(),
                DecisionQuestion::Noul {
                    instructions: json!("yes?"),
                    criteria: None,
                },
            ),
            (
                "c".into(),
                DecisionQuestion::Choice {
                    instructions: Value::Null,
                    criteria: BTreeMap::from([("a".into(), json!("A")), ("b".into(), json!("B"))]),
                },
            ),
            (
                "s".into(),
                DecisionQuestion::Score {
                    instructions: Value::Null,
                    criteria: vec![json!("low"), json!("high")],
                },
            ),
        ]),
    };
    let raw = json!({"model":"jev-1.13.0","answers":{"n":{"type":"noul","noul":0.7},"c":{"type":"choice","choice":"a","probabilities":{"a":0.8,"b":0.2},"confidence":0.8},"s":{"type":"score","score":0.8,"legend":{"0":"low","1":"high"},"probabilities":{"0":0.2,"1":0.8},"confidence":0.8}},"usage":{"input_tokens":100,"output_tokens":8}});
    assert!(decision::parse(&request, raw.clone()).is_ok());
    for malformed in ["probability", "legend", "ids", "usage"] {
        let mut raw = raw.clone();
        match malformed {
            "probability" => raw["answers"]["n"]["noul"] = json!(1.1),
            "legend" => raw["answers"]["s"]["legend"]["0"] = json!("wrong"),
            "ids" => {
                raw["answers"].as_object_mut().unwrap().remove("n");
            }
            _ => raw["usage"]["input_tokens"] = json!(-1),
        };
        assert!(decision::parse(&request, raw).is_err(), "{malformed}");
    }
}
