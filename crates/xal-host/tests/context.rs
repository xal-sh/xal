use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use serde_json::{Value, json};
use xal_host::{
    agent::{Agent, AgentEvent, Input, Journal, Options, SummaryTarget, history},
    *,
};
use xal_services::{
    credentials::new_id, records::Record, redactor::Redactor, settings::Settings, storage,
};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    redactor: Arc<Redactor>,
}
impl Fixture {
    fn new(enabled: bool) -> Self {
        let root = std::env::temp_dir().join(format!("xal-context-{}", new_id().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let cwd = root.join("work");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        storage::write_json(
            &home.join("config.json"),
            &json!({"typesafeAI":{"enabled":enabled,"profile":"decision"}}),
        )
        .unwrap();
        storage::write_json(&home.join("credentials.json"),&json!({"profiles":{"decision":{"name":"Decision","provider":"typesafe","credential":{"type":"api_key","key":"fixture-secret"}}}})).unwrap();
        Self {
            root,
            home,
            cwd,
            redactor: Arc::new(Redactor::new(vec!["fixture-secret".into()]).unwrap()),
        }
    }
    async fn host(&self, plugin: Mock) -> Host {
        let mut host = Host::new(vec![Box::new(plugin)], Cancellation::default());
        host.output_policy(self.redactor.clone(), self.root.join("artifacts"));
        host.decision_policy(decisions::Settings {
            home: self.home.clone(),
            cwd: self.cwd.clone(),
            profile: "decision".into(),
            redactor: self.redactor.clone(),
        });
        host.recorder =
            Some(recording::Recorder::new(&self.home, true, self.redactor.clone()).unwrap());
        host.permissions(
            permissions::Permissions::load(
                &Settings::parse(&JsonObject::new()).unwrap(),
                &self.home,
                &self.cwd,
                "normal",
            )
            .unwrap(),
        );
        host.start().await.unwrap();
        host
    }
    fn session(&self, host: &Host) -> Session {
        host.session(
            "session-private".into(),
            self.cwd.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap()
    }
    fn options(&self) -> Options {
        Options {
            provider: "fixture".into(),
            profile: None,
            model: "model".into(),
            mode: "normal".into(),
            instructions: "instructions".into(),
            thinking: None,
            context_window: 100_000,
            image_input: false,
            summary_target: Some(SummaryTarget {
                model: "fast".into(),
                thinking: Some("low".into()),
                image_input: false,
                context_window: 100_000,
            }),
            compaction_limit: None,
            output_schema: None,
            artifacts: self.root.join("artifacts"),
        }
    }
    fn journal(&self, name: &str) -> Journal {
        Journal::create(&self.root.join(name),&json!({"type":"meta","meta":{"version":2,"id":"session","cwd":self.cwd,"provider":"fixture","model":"model","mode":"normal"}})).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[derive(Clone)]
struct Mock {
    answers: Arc<Mutex<VecDeque<String>>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    decisions: Arc<Mutex<Vec<DecisionRequest>>>,
    mode: &'static str,
    reads: Arc<AtomicUsize>,
    disposed: Arc<AtomicUsize>,
}
impl Mock {
    fn new(mode: &'static str) -> Self {
        Self {
            answers: Arc::new(Mutex::new(VecDeque::from([
                "dense summary".into(),
                "answer".into(),
            ]))),
            requests: Arc::default(),
            decisions: Arc::default(),
            mode,
            reads: Arc::default(),
            disposed: Arc::default(),
        }
    }
}
impl Plugin for Mock {
    fn name(&self) -> &str {
        "fixture"
    }
    fn register(&mut self, r: &mut Registration) -> Result<()> {
        let mock = self.clone();
        r.provider(
            "fixture",
            Provider {
                settle: None,
                models: vec!["model".into(), "fast".into()],
                stream: Box::new(move |request, context, sender| {
                    let mock = mock.clone();
                    Box::pin(async move {
                        mock.requests.lock().unwrap().push(request);
                        if mock.mode == "cancel-summary" {
                            context.cancellation.cancelled().await;
                            return Err(Error::Cancelled);
                        }
                        let text = mock.answers.lock().unwrap().pop_front().unwrap();
                        sender
                            .send(ProviderEvent::Item(Item::AssistantMessage {
                                text,
                                replay: None,
                            }))
                            .await?;
                        sender
                            .send(ProviderEvent::Done {
                                usage: Some(Usage {
                                    total_input_tokens: Some(100),
                                    output_tokens: Some(5),
                                    ..Usage::default()
                                }),
                            })
                            .await
                    })
                }),
            },
        )?;
        let mock = self.clone();
        r.decision(
            "typesafe",
            Box::new(move |request, context| {
                let mock = mock.clone();
                Box::pin(async move {
                    mock.decisions.lock().unwrap().push(request.clone());
                    if matches!(mock.mode, "cancel-decision" | "deadline-decision") {
                        if let Some(observation) = &context.observation {
                            observation.usage(Usage {
                                total_input_tokens: Some(10),
                                ..Usage::default()
                            })?;
                        }
                        context.cancellation.cancelled().await;
                        return Err(Error::Cancelled);
                    }
                    if mock.mode == "fail" {
                        return Err(Error::Failed("fixture failure".into()));
                    }
                    let answers = request
                        .questions
                        .keys()
                        .map(|id| {
                            (
                                id.clone(),
                                DecisionAnswer::Noul {
                                    noul: match mock.mode {
                                        "keep" => 1.0,
                                        "truncate" => {
                                            if id.starts_with("call_") {
                                                1.0
                                            } else {
                                                0.0
                                            }
                                        }
                                        _ => 0.0,
                                    },
                                },
                            )
                        })
                        .collect();
                    Ok(DecisionResponse {
                        model: "jev-1.13.0".into(),
                        answers,
                        usage: Usage {
                            total_input_tokens: Some(17),
                            output_tokens: Some(2),
                            ..Usage::default()
                        },
                    })
                })
            }),
        )?;
        let reads = self.reads.clone();
        r.tool(
            "read",
            Tool {
                title: None,
                description: "read".into(),
                parameters: json!({"type":"object"}).as_object().unwrap().clone(),
                effects: Effects::read,
                concurrency: None,
                permission_subject: None,
                redact: None,
                available: Box::new(|_| Ok(true)),
                run: Box::new(move |args, _| {
                    let reads = reads.clone();
                    Box::pin(async move {
                        reads.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolResult {
                            output: std::fs::read_to_string(args["file_path"].as_str().unwrap())
                                .unwrap(),
                        })
                    })
                }),
            },
        )?;
        let disposed = self.disposed.clone();
        r.session_disposer(Box::new(move |_, _| {
            let disposed = disposed.clone();
            Box::pin(async move {
                disposed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }));
        Ok(())
    }
}
fn records(items: &[Item]) -> Vec<Record> {
    items
        .iter()
        .map(|i| Record::parse(&json!({"type":"item","item":i}).to_string()).unwrap())
        .collect()
}
fn authored() -> Item {
    serde_json::from_value(json!({"type":"user_message","text":"Keep the user's requirement","messageId":new_id().unwrap()})).unwrap()
}
fn history_items() -> Vec<Item> {
    let mut items = vec![
        authored(),
        Item::ToolCall {
            call_id: "old".into(),
            name: "read".into(),
            args: JsonObject::new(),
            replay: None,
        },
        Item::ToolResult {
            call_id: "old".into(),
            output: "obsolete output ".repeat(3000),
        },
    ];
    items.extend((0..6).map(|i| Item::AssistantMessage {
        text: format!("recent {i}"),
        replay: None,
    }));
    items
}

#[test]
fn all_historical_checkpoints_and_portable_replay_are_preserved() {
    let retained = vec![authored()];
    for strategy in [None, Some("user_messages_v1"), Some("jev_v1")] {
        let mut checkpoint = json!({"type":"compaction","summary":"summary","retained":retained,"replaced":3,"tokensBefore":100});
        if let Some(strategy) = strategy {
            checkpoint["strategy"] = json!(strategy);
        }
        let record = Record::parse(&json!({"type":"item","item":checkpoint}).to_string()).unwrap();
        let active = history::active(&[record]).unwrap();
        assert_eq!(active.len(), if strategy == Some("jev_v1") { 1 } else { 2 });
        assert_eq!(
            active
                .iter()
                .filter(|i| i.text().contains("summary"))
                .count(),
            usize::from(strategy != Some("jev_v1"))
        );
    }
    let shell=Record::parse(&json!({"type":"item","item":{"type":"direct_shell","command":"pwd","output":"/fixture","exitCode":0,"messageId":new_id().unwrap(),"callId":"shell","input":"!pwd","readOnly":true}}).to_string()).unwrap();
    assert!(
        history::active(&[shell]).unwrap()[0]
            .text()
            .contains("<shell-input>\npwd")
    );
    let input:Vec<Item>=serde_json::from_value(json!([
        {"type":"user_message","text":"authored","modelText":"effective","images":[{"mediaType":"image/png","data":"AA=="}]},
        {"type":"reasoning","summary":"private","replay":{"provider":"foreign","model":"old","data":{"signature":"opaque"}}},
        {"type":"tool_call","callId":"pending","name":"read","args":{},"replay":{"provider":"foreign","data":{"signed":true}}},
        {"type":"user_message","text":"next"}
    ])).unwrap();
    let portable = history::prepare(&input, "fixture", "model", false);
    assert_eq!(portable.len(), 4);
    assert_eq!(
        portable[0].text(),
        "effective\n\n[1 image attachment omitted]"
    );
    assert!(matches!(&portable[1], Item::ToolCall { replay: None, .. }));
    assert!(
        matches!(&portable[2],Item::ToolResult{call_id,output} if call_id == "pending" && output.contains("interrupted"))
    );
    assert_eq!(
        history::cache_key("model", "instructions", &[]),
        history::cache_key("model", "instructions", &[])
    );
    assert_ne!(
        history::cache_key("other", "instructions", &[]),
        history::cache_key("model", "instructions", &[])
    );
}

#[tokio::test]
async fn summaries_are_tool_free_atomic_and_unchanged_checkpoints_are_noops() {
    for valid in [true, false] {
        let fixture = Fixture::new(false);
        let mock = Mock::new("drop");
        if !valid {
            *mock.answers.lock().unwrap() = VecDeque::from([String::new()]);
        }
        let mut host = fixture.host(mock.clone()).await;
        let mut receive = |_| Ok(());
        let mut agent = Agent::new(
            &host,
            fixture.session(&host),
            fixture.options(),
            &fixture.redactor,
            Some(fixture.journal("session.jsonl")),
            &mut receive,
        )
        .unwrap();
        let original = history_items();
        agent.restore(&records(&original)).unwrap();
        assert_eq!(agent.compact(Some("unfinished task")).await.is_ok(), valid);
        if valid {
            assert_eq!(agent.history().len(), 2);
            assert!(!agent.compact(None).await.unwrap());
        } else {
            assert_eq!(agent.history(), original);
        }
        let requests = mock.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].tools.is_empty());
        assert_eq!(requests[0].model, "fast");
        assert_eq!(requests[0].thinking.as_deref(), Some("low"));
        assert!(
            requests[0]
                .input
                .last()
                .unwrap()
                .text()
                .contains("unfinished task")
        );
        drop(agent);
        let saved =
            xal_services::records::read_journal(&fixture.root.join("session.jsonl")).unwrap();
        assert_eq!(
            saved
                .iter()
                .filter(|r| r
                    .payload()
                    .get("item")
                    .is_some_and(|i| i["type"] == "compaction"))
                .count(),
            usize::from(valid)
        );
        if valid {
            let mut agent = Agent::new(
                &host,
                fixture.session(&host),
                fixture.options(),
                &fixture.redactor,
                Some(fixture.journal("continued.jsonl")),
                &mut receive,
            )
            .unwrap();
            agent.restore(&saved).unwrap();
            assert!(!agent.compact(None).await.unwrap());
            let continued =
                xal_services::records::read_journal(&fixture.root.join("continued.jsonl")).unwrap();
            assert_eq!(
                continued.last().unwrap().payload()["item"]["strategy"],
                "user_messages_v1"
            );
            assert_eq!(history::active(&continued).unwrap(), agent.history());
        }
        host.shutdown().await;
    }
}

#[tokio::test]
async fn checkpoint_delivery_failure_or_cancellation_rolls_back_history_and_journal() {
    for interrupted in [false, true] {
        let fixture = Fixture::new(false);
        let mut host = fixture.host(Mock::new("summary")).await;
        let session = fixture.session(&host);
        let cancel = session.cancellation.clone();
        let mut receive = |event| {
            if matches!(event, AgentEvent::Compacted { .. }) {
                if interrupted {
                    cancel.cancel();
                } else {
                    return Err(Error::Failed("fixture delivery failed".into()));
                }
            }
            Ok(())
        };
        let mut agent = Agent::new(
            &host,
            session,
            fixture.options(),
            &fixture.redactor,
            Some(fixture.journal("rollback.jsonl")),
            &mut receive,
        )
        .unwrap();
        let original = history_items();
        agent.restore(&records(&original)).unwrap();
        assert!(agent.compact(None).await.is_err());
        assert_eq!(agent.history(), original);
        let saved =
            xal_services::records::read_journal(&fixture.root.join("rollback.jsonl")).unwrap();
        assert_eq!(history::active(&saved).unwrap(), original);
        assert!(!saved.iter().any(|r| {
            r.payload()
                .get("item")
                .is_some_and(|i| i["type"] == "compaction")
        }));
        drop(agent);
        host.shutdown().await;
    }
}

#[tokio::test]
async fn compaction_cancellation_keeps_original_history_and_does_not_fallback() {
    for mode in ["cancel-summary", "cancel-decision"] {
        let fixture = Fixture::new(mode == "cancel-decision");
        let mock = Mock::new(mode);
        let mut host = fixture.host(mock.clone()).await;
        let session = fixture.session(&host);
        let cancel = session.cancellation.clone();
        let mut receive = |_| Ok(());
        let mut agent = Agent::new(
            &host,
            session,
            fixture.options(),
            &fixture.redactor,
            None,
            &mut receive,
        )
        .unwrap();
        let original = history_items();
        agent.restore(&records(&original)).unwrap();
        let (result, ()) = tokio::join!(agent.compact(None), async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            cancel.cancel();
        });
        assert_eq!(result, Err(Error::Cancelled));
        assert_eq!(agent.history(), original);
        assert_eq!(
            mock.requests.lock().unwrap().len(),
            usize::from(mode == "cancel-summary")
        );
        drop(agent);
        host.shutdown().await;
    }
}

#[tokio::test]
async fn jev_keeps_truncates_drops_and_visibly_falls_back_without_partial_mutation() {
    for mode in ["drop", "truncate", "keep", "fail"] {
        let fixture = Fixture::new(true);
        let mock = Mock::new(mode);
        let mut host = fixture.host(mock.clone()).await;
        let mut events = Vec::new();
        let mut receive = |event| {
            events.push(event);
            Ok(())
        };
        let mut agent = Agent::new(
            &host,
            fixture.session(&host),
            fixture.options(),
            &fixture.redactor,
            None,
            &mut receive,
        )
        .unwrap();
        let original = history_items();
        agent.restore(&records(&original)).unwrap();
        agent.compact(None).await.unwrap();
        match mode {
            "drop" => assert_eq!(agent.history().len(), 7),
            "truncate" => {
                assert_eq!(agent.history().len(), 9);
                assert!(agent.history()[2].text().contains("Jev compacted"));
                assert!(agent.history()[2].text().len() < 420);
            }
            _ => assert_eq!(agent.history().len(), 2),
        }
        assert_eq!(agent.history()[0], original[0]);
        assert_eq!(
            mock.requests.lock().unwrap().len(),
            usize::from(matches!(mode, "keep" | "fail"))
        );
        drop(agent);
        assert_eq!(
            events.iter().any(
                |e| matches!(e,AgentEvent::Error{message} if message.contains("falling back"))
            ),
            matches!(mode, "keep" | "fail")
        );
        host.shutdown().await;
    }
}

#[tokio::test]
async fn read_ahead_is_bounded_and_off_state_never_infers() {
    for enabled in [false, true] {
        let fixture = Fixture::new(enabled);
        let mock = Mock::new("keep");
        let mut host = fixture.host(mock.clone()).await;
        let mut names = Vec::new();
        for i in 0..50 {
            let name = format!("file-{i}.txt");
            std::fs::write(fixture.cwd.join(&name), "content").unwrap();
            names.push(name);
        }
        let mut receive = |_| Ok(());
        let mut agent = Agent::new(
            &host,
            fixture.session(&host),
            fixture.options(),
            &fixture.redactor,
            None,
            &mut receive,
        )
        .unwrap();
        assert_eq!(
            agent
                .run(Input {
                    text: names.join(" "),
                    images: Vec::new()
                })
                .await
                .unwrap()
                .exit_code(),
            0
        );
        assert_eq!(
            mock.reads.load(Ordering::SeqCst),
            if enabled { 4 } else { 0 }
        );
        assert_eq!(mock.decisions.lock().unwrap().len(), usize::from(enabled));
        if enabled {
            let requests = mock.decisions.lock().unwrap();
            assert_eq!(requests[0].questions.len(), 40);
            assert!(requests[0].state.to_string().len() < 100000);
            let text = mock.requests.lock().unwrap()[0].input[0].text().to_owned();
            assert_eq!(text.matches("[read-ahead] Prefetched").count(), 4);
            assert!(text.len() < 24000 + names.join(" ").len());
        }
        drop(agent);
        host.shutdown().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn read_ahead_does_not_bypass_sensitive_logical_symlink_permissions() {
    let fixture = Fixture::new(true);
    std::fs::write(fixture.cwd.join("settings.txt"), "sensitive-value").unwrap();
    std::os::unix::fs::symlink("settings.txt", fixture.cwd.join(".env")).unwrap();
    let mock = Mock::new("keep");
    let mut host = fixture.host(mock.clone()).await;
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(
        &host,
        fixture.session(&host),
        fixture.options(),
        &fixture.redactor,
        None,
        &mut receive,
    )
    .unwrap();
    agent
        .run(Input {
            text: "inspect .env".into(),
            images: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(mock.reads.load(Ordering::SeqCst), 0);
    assert!(
        !serde_json::to_string(&mock.requests.lock().unwrap()[0].input)
            .unwrap()
            .contains("sensitive-value")
    );
    drop(agent);
    host.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn decision_deadline_records_reported_usage_as_failed() {
    let fixture = Fixture::new(true);
    let mock = Mock::new("deadline-decision");
    let mut host = fixture.host(mock.clone()).await;
    let session = fixture.session(&host);
    let service = host.decision_service().unwrap().unwrap();
    let started = tokio::time::Instant::now();
    let result = service
        .evaluate(
            DecisionRequest {
                model: "jev-latest".into(),
                state: json!("state"),
                questions: BTreeMap::from([(
                    "q".into(),
                    DecisionQuestion::Noul {
                        instructions: json!("needed?"),
                        criteria: None,
                    },
                )]),
            },
            &session,
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("timed out"));
    assert_eq!(started.elapsed(), Duration::from_secs(60));
    assert_eq!(mock.decisions.lock().unwrap().len(), 1);
    let path = std::fs::read_dir(fixture.home.join("usage"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let raw: Value = serde_json::from_str(std::fs::read_to_string(path).unwrap().trim()).unwrap();
    assert_eq!(raw["outcome"], "failed");
    assert_eq!(raw["usage"]["totalInputTokens"], 10);
    host.shutdown().await;
}

#[tokio::test]
async fn decisions_preserve_identifiers_record_resolved_models_and_cleanup_ignores_bad_config() {
    let fixture = Fixture::new(true);
    let mock = Mock::new("keep");
    let mut host = fixture.host(mock.clone()).await;
    let session = fixture.session(&host);
    let service = host.decision_service().unwrap().unwrap();
    let request = DecisionRequest {
        model: "jev-latest".into(),
        state: json!("fixture-secret"),
        questions: BTreeMap::from([(
            "q".into(),
            DecisionQuestion::Noul {
                instructions: json!("fixture-secret"),
                criteria: None,
            },
        )]),
    };
    let response = service.evaluate(request.clone(), &session).await.unwrap();
    assert_eq!(response.model, "jev-1.13.0");
    assert_eq!(mock.decisions.lock().unwrap()[0].state, json!("[REDACTED]"));
    let mut invalid = request;
    invalid.questions.insert(
        "fixture-secret".into(),
        DecisionQuestion::Noul {
            instructions: Value::Null,
            criteria: None,
        },
    );
    assert!(service.evaluate(invalid, &session).await.is_err());
    assert_eq!(mock.decisions.lock().unwrap().len(), 1);
    let ledger = std::fs::read_to_string(
        std::fs::read_dir(fixture.home.join("usage"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    assert!(ledger.contains("jev-1.13.0"));
    assert!(!ledger.contains("jev-latest"));
    assert!(!ledger.contains("session-private"));
    assert!(!ledger.contains("fixture-secret"));
    assert_eq!(
        recording::read_usage(&fixture.home.join("usage")).unwrap()["requests"],
        1
    );
    std::fs::write(fixture.home.join("config.json"), "invalid").unwrap();
    host.dispose_session(&session).await.unwrap();
    assert_eq!(mock.disposed.load(Ordering::SeqCst), 1);
    host.shutdown().await;
}
