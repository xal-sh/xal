use std::sync::{Arc, Mutex};

use super::*;
use xal_services::{credentials::new_id, redactor::Redactor, storage};

struct Fixture {
    home: PathBuf,
    redactor: Arc<Redactor>,
    requests: Arc<Mutex<Vec<DecisionRequest>>>,
}
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("xal-classify-{}", new_id().unwrap()));
        std::fs::create_dir(&home).unwrap();
        storage::write_json(
            &home.join("config.json"),
            &json!({"typesafeAI":{"enabled":true,"profile":"fixture"}}),
        )
        .unwrap();
        storage::write_json(&home.join("credentials.json"),&json!({"profiles":{"fixture":{"name":"Fixture","provider":"typesafe","credential":{"type":"api_key","key":"secret-value"}}}})).unwrap();
        Self {
            home,
            redactor: Arc::new(Redactor::new(vec!["secret-value".into()]).unwrap()),
            requests: Arc::default(),
        }
    }
    async fn host(&self, fail: bool) -> Host {
        let mut host = Host::new(
            vec![
                Box::new(Classify {
                    home: self.home.clone(),
                    cwd: self.home.clone(),
                }),
                Box::new(Decision {
                    requests: self.requests.clone(),
                    fail,
                }),
            ],
            Cancellation::default(),
        );
        host.decision_policy(decisions::Settings {
            home: self.home.clone(),
            cwd: self.home.clone(),
            profile: "fixture".into(),
            redactor: self.redactor.clone(),
        });
        host.output_policy(self.redactor.clone(), self.home.join("artifacts"));
        host.recorder =
            Some(recording::Recorder::new(&self.home, false, self.redactor.clone()).unwrap());
        host.start().await.unwrap();
        host
    }
    fn session(&self, host: &Host) -> Session {
        host.session(
            "session".into(),
            self.home.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.home).unwrap();
    }
}
struct Decision {
    requests: Arc<Mutex<Vec<DecisionRequest>>>,
    fail: bool,
}
impl Plugin for Decision {
    fn name(&self) -> &str {
        "fixture-decision"
    }
    fn register(&mut self, r: &mut Registration) -> Result<()> {
        r.policy(
            "allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        r.provider("fixture", Provider {
            settle: None,
            models: vec!["model".into()],
            stream: Box::new(|request, _, sender| Box::pin(async move {
                let recovered = request.input.iter().any(|item| matches!(item, Item::ToolResult { call_id, .. } if call_id == "live"));
                sender.send(ProviderEvent::Item(if recovered {
                    Item::AssistantMessage { text: "recovered".into(), replay: None }
                } else {
                    Item::ToolCall { call_id: "live".into(), name: "classify".into(), args: JsonObject::new(), replay: None }
                })).await?;
                sender.send(ProviderEvent::Done { usage: None }).await
            })),
        })?;
        let requests = self.requests.clone();
        let fail = self.fail;
        r.decision(
            "typesafe",
            Box::new(move |request, context| {
                let requests = requests.clone();
                Box::pin(async move {
                    let count = {
                        let mut requests = requests.lock().unwrap();
                        requests.push(request.clone());
                        requests.len()
                    };
                    let usage = Usage {
                        total_input_tokens: Some(10),
                        output_tokens: Some(2),
                        ..Usage::default()
                    };
                    context.observation.as_ref().unwrap().usage(usage.clone())?;
                    if fail && count == 2 {
                        return Err(Error::Failed("fixture stopped".into()));
                    }
                    Ok(DecisionResponse {
                        model: "jev-1.13.0".into(),
                        answers: request
                            .questions
                            .keys()
                            .map(|id| (id.clone(), DecisionAnswer::Noul { noul: 0.8 }))
                            .collect(),
                        usage,
                    })
                })
            }),
        )
    }
}
fn evaluation(id: &str) -> Value {
    json!({"id":id,"state":"secret-value","questions":{"question":{"type":"noul","instructions":"secret-value"}}})
}
fn args(evaluations: Vec<Value>) -> JsonObject {
    json!({"evaluations":evaluations})
        .as_object()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn malformed_calls_remain_readable_and_recover_through_tool_validation() {
    use xal_host::agent::{Agent, Input, Options};
    let fixture = Fixture::new();
    let mut host = fixture.host(false).await;
    let args = json!({"unexpected":"secret-value"})
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(
        redact(&args, &fixture.redactor).unwrap()["unexpected"],
        "[REDACTED]"
    );
    let history = vec![
        Item::user("previous".into()),
        Item::ToolCall {
            call_id: "historical".into(),
            name: "classify".into(),
            args: JsonObject::new(),
            replay: None,
        },
        Item::ToolResult {
            call_id: "historical".into(),
            output: "Tool failed: missing evaluations".into(),
        },
    ];
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(
        &host,
        fixture.session(&host),
        Options {
            provider: "fixture".into(),
            profile: None,
            model: "model".into(),
            mode: "normal".into(),
            instructions: "instructions".into(),
            thinking: None,
            context_window: 100000,
            image_input: false,
            summary_target: None,
            compaction_limit: None,
            output_schema: None,
            artifacts: fixture.home.join("artifacts"),
        },
        &fixture.redactor,
        None,
        &mut receive,
    )
    .unwrap();
    let records = history
        .iter()
        .map(|item| {
            xal_services::records::Record::parse(&json!({"type":"item","item":item}).to_string())
                .unwrap()
        })
        .collect::<Vec<_>>();
    agent.restore(&records).unwrap();
    assert_eq!(agent.history(), history);
    let result = agent
        .run(Input {
            text: "continue".into(),
            images: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(result.exit_code(), 0);
    assert!(agent.history().iter().any(|item| matches!(item, Item::ToolResult { call_id, output } if call_id == "live" && output.contains("evaluations"))));
    assert!(fixture.requests.lock().unwrap().is_empty());
    drop(agent);
    host.shutdown().await;
}

#[tokio::test]
async fn classify_preflights_the_whole_call_and_preserves_secret_free_identities() {
    let fixture = Fixture::new();
    let mut host = fixture.host(false).await;
    let session = fixture.session(&host);
    let mut oversized = evaluation("second");
    oversized["state"] = json!("x".repeat(30000));
    let mut secret_question = evaluation("first");
    secret_question["questions"] =
        json!({"secret-value":{"type":"noul","instructions":"description"}});
    for input in [
        args(vec![evaluation("same"), evaluation("same")]),
        args(vec![evaluation("first"), oversized]),
        args(vec![evaluation("secret-value")]),
        args(vec![secret_question]),
    ] {
        let result = async {
            let prepared = host.prepare_tool("classify", input, &session).await?;
            host.execute_tool(prepared, &session).await
        }
        .await;
        assert!(result.is_err());
        assert!(fixture.requests.lock().unwrap().is_empty());
    }
    let prepared = host
        .prepare_tool("classify", args(vec![evaluation("first")]), &session)
        .await
        .unwrap();
    let result = host.execute_tool(prepared, &session).await.unwrap();
    let result: Value = serde_json::from_str(&result.output).unwrap();
    assert_eq!(result["evaluations"][0]["id"], "first");
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests[0].model, "jev-latest");
    assert_eq!(requests[0].state, "[REDACTED]");
    assert!(requests[0].questions.contains_key("question"));
    fixture
        .redactor
        .protect(vec!["a-secret-key".into()])
        .unwrap();
    let choice:DecisionRequest=serde_json::from_value(json!({"model":"jev-latest","state":"state","questions":{"q":{"type":"choice","instructions":null,"criteria":{"a-secret-key":"A","b":"B"}}}})).unwrap();
    assert!(decisions::redact(&choice, &fixture.redactor).is_err());
    host.shutdown().await;
}

#[tokio::test]
async fn classify_batches_sequentially_and_records_partial_failure_without_a_result() {
    for fail in [false, true] {
        let fixture = Fixture::new();
        let mut host = fixture.host(fail).await;
        let session = fixture.session(&host);
        let mut input = evaluation("batched");
        input["questions"] = json!({"a":{"type":"noul","instructions":"a".repeat(22000)},"b":{"type":"noul","instructions":"b".repeat(22000)},"c":{"type":"noul","instructions":"c".repeat(22000)}});
        let prepared = host
            .prepare_tool("classify", args(vec![input]), &session)
            .await
            .unwrap();
        let result = host.execute_tool(prepared, &session).await;
        assert_eq!(fixture.requests.lock().unwrap().len(), 2);
        if fail {
            assert!(
                result
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("1/2 requests completed")
            );
        } else {
            let output: Value = serde_json::from_str(&result.unwrap().output).unwrap();
            assert_eq!(output["requests"], 2);
            assert_eq!(
                output["evaluations"][0]["answers"]
                    .as_object()
                    .unwrap()
                    .len(),
                3
            );
        }
        let usage = recording::read_usage(&fixture.home.join("usage")).unwrap();
        assert_eq!(usage["requests"], 2);
        assert_eq!(usage["usage"]["outputTokens"], 4);
        host.shutdown().await;
    }
}

#[tokio::test]
async fn typesafe_off_hides_classify_and_rechecks_already_prepared_calls() {
    let fixture = Fixture::new();
    let mut host = fixture.host(false).await;
    let session = fixture.session(&host);
    let prepared = host
        .prepare_tool("classify", args(vec![evaluation("first")]), &session)
        .await
        .unwrap();
    storage::write_json(
        &fixture.home.join("config.json"),
        &json!({"typesafeAI":{"enabled":false,"profile":"fixture"}}),
    )
    .unwrap();
    assert!(host.tools(&session).unwrap().is_empty());
    assert!(host.execute_tool(prepared, &session).await.is_err());
    assert!(fixture.requests.lock().unwrap().is_empty());
    assert!(!fixture.home.join("usage").exists());
    host.shutdown().await;
}
