use super::*;

fn events(protocol: Protocol) -> String {
    let events = match protocol {
        Protocol::Responses => vec![
            json!({"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"opaque"}}),
            json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"call","name":"read","arguments":"{\"file_path\":\"a.rs\"}"}}),
            json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":3}}}),
        ],
        Protocol::Chat => vec![
            json!({"choices":[{"delta":{"reasoning_content":"plan","tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\"file_path\":\"a.rs\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}),
        ],
        Protocol::Messages => vec![
            json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"plan","signature":"signed"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call","name":"read","input":{"file_path":"a.rs"}}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ],
        Protocol::Gemini => vec![
            json!({"candidates":[{"content":{"parts":[{"text":"plan","thought":true,"thoughtSignature":"signed"},{"functionCall":{"id":"call","name":"read","args":{"file_path":"a.rs"}},"thoughtSignature":"call-signature"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}}),
        ],
    };
    let mut text = events
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect::<String>();
    if protocol == Protocol::Chat {
        text.push_str("data: [DONE]\n\n");
    }
    text
}

#[tokio::test]
async fn streaming_routes_all_provider_protocols_and_replays_with_stable_identities() {
    for (id, name, protocol) in [
        (Id::OpenAi, "gpt-4.1", Protocol::Responses),
        (Id::ChatGpt, "gpt-5.6-fast", Protocol::Responses),
        (Id::Xai, "grok-4.5", Protocol::Responses),
        (Id::Anthropic, "claude-opus-5", Protocol::Messages),
        (Id::Google, "gemini-3.1-pro-preview", Protocol::Gemini),
        (Id::DeepSeek, "deepseek-v4-pro", Protocol::Chat),
        (Id::Alibaba, "qwen3.7-plus", Protocol::Chat),
        (Id::OpenRouter, "anthropic/claude-opus-5", Protocol::Chat),
        (Id::MiniMax, "MiniMax-M3", Protocol::Messages),
        (Id::MiniMaxPlan, "MiniMax-M2.7", Protocol::Messages),
        (Id::Copilot, "gpt-4.1", Protocol::Chat),
        (Id::Copilot, "gpt-5.6", Protocol::Responses),
        (Id::Go, "glm-5.3", Protocol::Chat),
        (Id::Go, "gpt-5.6-luna", Protocol::Responses),
        (Id::Go, "minimax-m3", Protocol::Messages),
    ] {
        let server = Server::new(vec![
            (200, events(protocol), Duration::ZERO),
            (200, events(protocol), Duration::ZERO),
        ])
        .await;
        let mut connection = client(id);
        connection.endpoint = server.url.clone();
        if id == Id::ChatGpt {
            connection.account = Account::Fixed(Credential::OAuth {
                access: "fixture-key".into(),
                refresh: "fixture-refresh".into(),
                expires: 9_000_000_000_000.0,
                account_id: Some("fixture-account".into()),
            });
        }
        let model = if id == Id::Copilot {
            catalog::parse_models(id, &json!({"data":[{"id":name,"name":name,"model_picker_enabled":true,"supported_endpoints":[protocol],"capabilities":{"supports":{"vision":true}}}]}),true,260000).unwrap().remove(0)
        } else {
            catalog::model_info(id, name, 260000).unwrap()
        };
        assert_eq!(model.protocol(id).unwrap(), protocol);
        let mut request = request(name);
        if id == Id::Copilot {
            request.input = vec![Item::UserMessage {
                text: "question".into(),
                model_text: None,
                message_id: None,
                images: vec![json!({"mediaType":"image/png","data":"aW1hZ2U="})],
            }];
        }
        for turn in 0..2 {
            let (sender, mut receiver) = channel(64, Cancellation::default()).unwrap();
            connection
                .stream(&model, request.clone(), &Cancellation::default(), sender)
                .await
                .unwrap();
            let mut received = Vec::new();
            while let Some(event) = receiver.recv().await.unwrap() {
                received.push(event);
            }
            assert!(received.iter().any(|e| matches!(e, ProviderEvent::Done { usage:Some(u) } if u.total_input_tokens == Some(10) && u.output_tokens == Some(3))));
            let items = output(received);
            assert!(
                items
                    .iter()
                    .any(|i| matches!(i,Item::Reasoning { summary,.. } if summary == "plan"))
            );
            assert!(items.iter().any(|i| matches!(i,Item::ToolCall { call_id,args,.. } if call_id == "call" && args["file_path"] == "a.rs")));
            if turn == 0 {
                request.input.extend(items);
                request.input.push(result());
            }
        }
        let requests = server.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        let header = |index: usize, key: &str| {
            requests[index]
                .0
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{key}: ")))
                .unwrap()
                .to_owned()
        };
        let route = match protocol {
            Protocol::Responses => "/responses",
            Protocol::Chat => "/chat/completions",
            Protocol::Messages => "/messages",
            Protocol::Gemini => "/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
        };
        for (headers, _) in &requests {
            assert!(
                headers.starts_with(&format!("POST {route} ")),
                "{id:?}: {headers}"
            );
        }
        match id {
            Id::Go | Id::Xai => {
                let key = if id == Id::Go {
                    "x-opencode-session"
                } else {
                    "x-grok-conv-id"
                };
                assert_eq!(header(0, key), "session-identity");
                assert_eq!(header(0, key), header(1, key));
            }
            Id::Copilot => {
                assert_eq!(header(0, "x-initiator"), "user");
                assert_eq!(header(1, "x-initiator"), "agent");
                assert_eq!(header(0, "x-interaction-id"), header(1, "x-interaction-id"));
                assert_eq!(header(0, "copilot-vision-request"), "true");
            }
            Id::ChatGpt => {
                assert_eq!(header(0, "chatgpt-account-id"), "fixture-account");
                assert_eq!(header(0, "session-id"), header(1, "session-id"));
            }
            Id::Anthropic | Id::MiniMax | Id::MiniMaxPlan => {
                assert_eq!(header(0, "x-api-key"), "fixture-key")
            }
            Id::Google => assert_eq!(header(0, "x-goog-api-key"), "fixture-key"),
            _ => assert_eq!(header(0, "authorization"), "Bearer fixture-key"),
        }
        let body: Value = serde_json::from_str(&requests[1].1).unwrap();
        match protocol {
            Protocol::Responses => {
                assert!(
                    body["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|i| i["type"] == "function_call_output" && i["call_id"] == "call")
                );
                assert_eq!(body.to_string().contains("opaque"), id != Id::Xai);
            }
            Protocol::Chat => {
                assert_eq!(body["messages"][2]["reasoning_content"], "plan");
                assert_eq!(body["messages"][3]["tool_call_id"], "call");
            }
            Protocol::Messages => {
                assert_eq!(body["messages"][1]["content"][0]["signature"], "signed");
                assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call");
            }
            Protocol::Gemini => {
                assert_eq!(
                    body["contents"][1]["parts"][0]["thoughtSignature"],
                    "signed"
                );
                assert_eq!(
                    body["contents"][2]["parts"][0]["functionResponse"]["id"],
                    "call"
                );
            }
        }
    }
}

#[test]
fn thinking_and_sampling_preserve_provider_model_family_branches() {
    for (name, effort, thinking) in [
        (
            "claude-haiku-4-5",
            "low",
            json!({"type":"enabled","budget_tokens":4096}),
        ),
        (
            "claude-opus-5",
            "high",
            json!({"type":"adaptive","display":"summarized"}),
        ),
        ("claude-opus-5", "none", json!({"type":"disabled"})),
    ] {
        let mut request = request(name);
        request.thinking = Some(effort.into());
        let body = client(Id::Anthropic)
            .body(
                &catalog::model_info(Id::Anthropic, name, 260000).unwrap(),
                &request,
            )
            .unwrap();
        assert_eq!(body["thinking"], thinking);
        if name == "claude-opus-5" && effort == "high" {
            assert_eq!(body["output_config"]["effort"], "high");
        }
    }
    for id in [Id::MiniMax, Id::MiniMaxPlan] {
        for (name, top_k) in [("MiniMax-M2", 20), ("MiniMax-M2.7", 40)] {
            let body = client(id)
                .body(
                    &catalog::model_info(id, name, 260000).unwrap(),
                    &request(name),
                )
                .unwrap();
            assert_eq!(body["temperature"], 1);
            assert_eq!(body["top_p"], 0.95);
            assert_eq!(body["top_k"], top_k);
        }
        for (effort, expected) in [("none", "disabled"), ("high", "adaptive")] {
            let mut request = request("MiniMax-M3");
            request.thinking = Some(effort.into());
            assert_eq!(
                client(id)
                    .body(
                        &catalog::model_info(id, &request.model, 260000).unwrap(),
                        &request
                    )
                    .unwrap()["thinking"]["type"],
                expected
            );
        }
    }
    for (name, effort, expected) in [
        (
            "gemini-3.1-pro-preview",
            "none",
            json!({"thinkingLevel":"LOW","includeThoughts":false}),
        ),
        (
            "gemini-3.5-flash",
            "none",
            json!({"thinkingLevel":"MINIMAL","includeThoughts":false}),
        ),
        (
            "gemini-3.5-flash",
            "medium",
            json!({"thinkingLevel":"MEDIUM","includeThoughts":true}),
        ),
        (
            "gemini-2.5-pro",
            "low",
            json!({"thinkingBudget":4096,"includeThoughts":true}),
        ),
    ] {
        let mut request = request(name);
        request.thinking = Some(effort.into());
        assert_eq!(
            gemini::body(&request).unwrap()["generationConfig"]["thinkingConfig"],
            expected
        );
    }
    for (name, effort, expected) in [
        ("grok-4.5", "max", Some("xhigh")),
        ("grok-4.5", "none", None),
        ("grok-build", "high", None),
        ("grok-4.20-0309-reasoning", "high", None),
        ("grok-composer-2.5-fast", "high", None),
        ("grok-4.20-0309-non-reasoning", "high", None),
    ] {
        let mut request = request(name);
        request.thinking = Some(effort.into());
        let body = responses::body(Id::Xai, &request).unwrap();
        assert_eq!(
            body.pointer("/reasoning/effort").and_then(Value::as_str),
            expected
        );
    }
}
