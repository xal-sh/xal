use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use xal_host::agent::{Agent, AgentEvent, Input, Journal, Options, Outcome};
use xal_host::interactions::{Answer, Answers};
use xal_host::*;
use xal_services::redactor::Redactor;
use xal_services::workflows::{GoalStatus, SuspensionCause};

struct Fixture {
    root: PathBuf,
    rounds: Arc<Mutex<VecDeque<Vec<Item>>>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    evaluation: Option<Arc<tokio::sync::Notify>>,
    release: Arc<tokio::sync::Notify>,
}

impl Fixture {
    fn new(rounds: Vec<Vec<Item>>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-workflows-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            root,
            rounds: Arc::new(Mutex::new(rounds.into())),
            requests: Arc::default(),
            evaluation: None,
            release: Arc::default(),
        }
    }
    async fn host(&self, redactor: Arc<Redactor>) -> Host {
        let mut host = Host::new(
            vec![
                Box::new(Mock {
                    rounds: self.rounds.clone(),
                    requests: self.requests.clone(),
                    evaluation: self.evaluation.clone(),
                    release: self.release.clone(),
                }),
                Box::new(xal_host::workflows::Workflows {
                    home: self.root.clone(),
                    redactor,
                }),
            ],
            Cancellation::default(),
        );
        host.start().await.unwrap();
        host
    }
    fn options(&self, mode: &str) -> Options {
        Options {
            provider: "mock".into(),
            profile: Some("original-account".into()),
            model: "mock".into(),
            mode: mode.into(),
            instructions: "Work carefully".into(),
            thinking: None,
            context_window: 100_000,
            image_input: false,
            summary_target: None,
            compaction_limit: None,
            output_schema: None,
            artifacts: self.root.join("session"),
        }
    }
    fn journal(&self) -> Journal {
        Journal::create(&self.root.join("session.jsonl"), &meta("session")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Mock {
    rounds: Arc<Mutex<VecDeque<Vec<Item>>>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    evaluation: Option<Arc<tokio::sync::Notify>>,
    release: Arc<tokio::sync::Notify>,
}
impl Plugin for Mock {
    fn name(&self) -> &str {
        "mock"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let rounds = self.rounds.clone();
        let requests = self.requests.clone();
        let evaluation = Arc::new(Mutex::new(self.evaluation.clone()));
        let release = self.release.clone();
        registration.policy(
            "allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.provider(
            "mock",
            Provider {
                settle: None,
                models: vec!["mock".into()],
                stream: Box::new(move |request, _, sender| {
                    let rounds = rounds.clone();
                    let requests = requests.clone();
                    let evaluation = evaluation.clone();
                    let release = release.clone();
                    Box::pin(async move {
                        let evaluating = request.phase == recording::Phase::GoalEvaluation;
                        requests.lock().unwrap().push(request);
                        let gate = if evaluating {
                            evaluation.lock().unwrap().take()
                        } else {
                            None
                        };
                        if let Some(started) = gate {
                            started.notify_one();
                            release.notified().await;
                        }
                        let items =
                            rounds.lock().unwrap().pop_front().ok_or_else(|| {
                                Error::Failed("unexpected provider request".into())
                            })?;
                        for item in items {
                            sender.send(ProviderEvent::Item(item)).await?;
                        }
                        sender
                            .send(ProviderEvent::Done {
                                usage: Some(Usage {
                                    total_input_tokens: Some(3),
                                    output_tokens: Some(1),
                                    ..Default::default()
                                }),
                            })
                            .await
                    })
                }),
            },
        )
    }
}

fn answer(text: &str) -> Vec<Item> {
    vec![Item::AssistantMessage {
        text: text.into(),
        replay: None,
    }]
}
fn call(name: &str, args: Value) -> Vec<Item> {
    vec![Item::ToolCall {
        call_id: "call".into(),
        name: name.into(),
        args: args.as_object().unwrap().clone(),
        replay: None,
    }]
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        images: Vec::new(),
    }
}
fn meta(id: &str) -> Value {
    json!({"type":"meta","meta":{"version":2,"id":id,"cwd":"/workspace","provider":"mock","profile":"original-account","model":"mock","mode":"normal","startedAt":0}})
}
fn user(journal: &mut Journal, id: &str, text: &str) {
    journal.append(&json!({"type":"event","event":{"type":"user_message","messageId":id,"text":text,"imageCount":0,"sentAt":0}})).unwrap();
    journal
        .append(&json!({"type":"item","item":{"type":"user_message","messageId":id,"text":text}}))
        .unwrap();
}

#[test]
fn recovery_is_validated_before_truncation_and_ownership_is_exclusive() {
    let fixture = Fixture::new(vec![]);
    let path = fixture.root.join("session.jsonl");
    let journal = fixture.journal();
    assert!(Journal::resume(&path).is_err());
    drop(journal);
    let valid = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{valid}{{\"type\":")).unwrap();
    let (journal, loaded) = Journal::resume(&path).unwrap();
    assert!(loaded.incomplete_tail);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), valid);
    drop(journal);
    let mut split = valid.as_bytes().to_vec();
    split.extend([b'{', b'"', 0xf0, 0x9f]);
    std::fs::write(&path, split).unwrap();
    let (journal, loaded) = Journal::resume(&path).unwrap();
    assert!(loaded.incomplete_tail);
    assert_eq!(std::fs::read(&path).unwrap(), valid.as_bytes());
    drop(journal);
    let invalid =
        format!("{valid}{{\"type\":\"event\",\"event\":{{\"type\":\"unknown\"}}}}\npartial");
    std::fs::write(&path, &invalid).unwrap();
    assert!(Journal::resume(&path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), invalid);
}

#[test]
fn historical_export_accepts_omitted_image_count_and_fractional_hook_duration() {
    let fixture = Fixture::new(vec![]);
    let mut journal = fixture.journal();
    journal
        .append(&json!({"type":"event","event":{"type":"user_message","text":"historical prompt"}}))
        .unwrap();
    journal.append(&json!({"type":"event","event":{"type":"hook_finished","hook":"fixture","event":"turn_end","action":"continued","elapsedMs":1.5}})).unwrap();
    let exported = xal_services::sessions::export::markdown(&journal.snapshot().unwrap()).unwrap();
    assert!(exported.contains("## User\n\nhistorical prompt"));
    assert!(exported.contains("fixture · turn_end · continued · 1.5ms"));
}

#[test]
fn replay_fork_and_history_movement_preserve_identity_and_signed_data() {
    let fixture = Fixture::new(vec![]);
    let mut journal = fixture.journal();
    let one = xal_services::credentials::new_id().unwrap();
    let two = xal_services::credentials::new_id().unwrap();
    user(&mut journal, &one, "first");
    journal.append(&json!({"type":"item","item":{"type":"tool_call","callId":"a","name":"read","args":{},"replay":{"provider":"mock","data":{"signed":"opaque"}}}})).unwrap();
    journal.append(&json!({"type":"event","event":{"type":"tool_call_updated","callId":"a","tool":"read","args":{}}})).unwrap();
    user(&mut journal, &two, "second");
    journal.append(&json!({"type":"item","item":{"type":"compaction","summary":"checkpoint","retained":[],"replaced":3}})).unwrap();
    journal.append(&json!({"type":"event","event":{"type":"conversation_rewound","messageId":one,"prompt":"first","fileCount":0,"removedMessages":2}})).unwrap();
    let snapshot = journal.snapshot().unwrap();
    assert!(snapshot.conversation.items.is_empty());
    assert_eq!(snapshot.redos.len(), 2);
    journal.append(&json!({"type":"event","event":{"type":"conversation_redone","messageId":one,"prompt":"first","fileCount":0,"restoredMessages":1}})).unwrap();
    assert_eq!(
        journal.snapshot().unwrap().conversation.items[1]["replay"]["data"]["signed"],
        "opaque"
    );
    let fork = journal
        .fork(&fixture.root.join("fork.jsonl"), "fork", 1)
        .unwrap();
    let forked = fork.snapshot().unwrap();
    assert_eq!(forked.meta.parent_id.as_deref(), Some("session"));
    assert_eq!(forked.current.profile.as_deref(), Some("original-account"));
    assert_eq!(
        forked.records[1..],
        journal.snapshot().unwrap().records[1..]
    );
    assert!(
        xal_services::sessions::export::markdown(&forked)
            .unwrap()
            .contains("second")
    );
    drop(fork);
    drop(journal);
}

#[tokio::test]
async fn goal_evaluation_is_independent_accumulates_usage_and_turns_remain_reusable() {
    let fixture = Fixture::new(vec![
        answer("first evidence"),
        answer(r#"{"verdict":"not_yet_met","reason":"need more evidence"}"#),
        answer("second evidence"),
        answer(r#"{"verdict":"met","reason":"complete evidence"}"#),
        answer("next request"),
    ]);
    let redactor = Arc::new(Redactor::new(vec![]).unwrap());
    let mut host = fixture.host(redactor.clone()).await;
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    let mut events = Vec::new();
    let mut receive = |event| {
        events.push(event);
        Ok(())
    };
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    agent.start_goal("prove the work").unwrap();
    assert!(matches!(
        agent.run_turn(input("work")).await.unwrap(),
        Outcome::Completed { .. }
    ));
    let goal = agent.goal().unwrap();
    assert!(matches!(goal.status, GoalStatus::Achieved { .. }));
    assert_eq!(goal.evaluated_turns, 2);
    assert_eq!(goal.usage.total_input_tokens, Some(12));
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert!(requests[1].tools.is_empty());
    assert_eq!(requests[1].phase, recording::Phase::GoalEvaluation);
    assert_eq!(requests[1].profile.as_deref(), Some("original-account"));
    assert!(
        !agent
            .history()
            .iter()
            .any(|item| item.text().contains("\"verdict\""))
    );
    drop(requests);
    assert!(matches!(
        agent.run_turn(input("next")).await.unwrap(),
        Outcome::Completed { .. }
    ));
    agent
        .rewind(&agent.snapshot().unwrap().conversation.checkpoints[1].message_id)
        .unwrap();
    agent.redo().unwrap();
    agent.close().await.unwrap();
    drop(agent);
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::UserMessage { .. }))
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, AgentEvent::TurnEnded { .. }))
            .count(),
        3
    );
    let first_end = events
        .iter()
        .position(|e| matches!(e, AgentEvent::TurnEnded { .. }))
        .unwrap();
    let evaluator = events
        .iter()
        .position(|e| {
            matches!(
                e,
                AgentEvent::StateChanged {
                    state: xal_host::agent::AgentState::EvaluatingGoal
                }
            )
        })
        .unwrap();
    assert!(first_end < evaluator);
    host.shutdown().await;
}

#[tokio::test]
async fn input_queued_during_evaluation_is_consumed_once_after_the_verdict() {
    let mut fixture = Fixture::new(vec![
        answer("evidence"),
        answer(r#"{"verdict":"met","reason":"verified"}"#),
        answer("answered the queued request"),
        answer("all work complete"),
    ]);
    let started = Arc::new(tokio::sync::Notify::new());
    fixture.evaluation = Some(started.clone());
    let redactor = Arc::new(Redactor::new(vec![]).unwrap());
    let mut host = fixture.host(redactor.clone()).await;
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Interactive,
            false,
        )
        .unwrap();
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    agent.start_goal("verify evidence").unwrap();
    let control = agent.control();
    let (outcome, ()) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(agent.run_turn(input("work")), async {
            started.notified().await;
            control.queue(input("queued during evaluation")).unwrap();
            fixture.release.notify_one();
        })
    })
    .await
    .unwrap();
    assert!(matches!(outcome.unwrap(), Outcome::Completed { .. }));
    assert!(matches!(
        agent.goal().unwrap().status,
        GoalStatus::Achieved { .. }
    ));
    assert_eq!(agent.history().iter().filter(|i| matches!(i, Item::UserMessage { text, .. } if text == "queued during evaluation")).count(), 1);
    assert_eq!(fixture.requests.lock().unwrap().len(), 4);
    assert!(
        !fixture.requests.lock().unwrap()[1]
            .input
            .iter()
            .any(|i| i.text() == "queued during evaluation")
    );
    assert!(
        fixture.requests.lock().unwrap()[2]
            .input
            .iter()
            .any(|i| i.text() == "queued during evaluation")
    );
    agent.close().await.unwrap();
    drop(agent);
    host.shutdown().await;
}

#[tokio::test]
async fn no_progress_stops_after_eight_evaluations() {
    let fixture = Fixture::new(
        (0..8)
            .flat_map(|_| {
                [
                    answer("no tools"),
                    answer(r#"{"verdict":"not_yet_met","reason":"missing evidence"}"#),
                ]
            })
            .collect(),
    );
    let redactor = Arc::new(Redactor::new(vec![]).unwrap());
    let mut host = fixture.host(redactor.clone()).await;
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    agent.start_goal("make progress").unwrap();
    agent.run(input("work")).await.unwrap();
    assert!(matches!(
        agent.goal().unwrap().status,
        GoalStatus::Suspended {
            suspension_cause: SuspensionCause::NoProgress,
            ..
        }
    ));
    assert_eq!(fixture.requests.lock().unwrap().len(), 16);
    drop(agent);
    host.shutdown().await;
}

#[tokio::test]
async fn dismissed_plan_stays_idle_and_approved_plan_restores_writable_mode() {
    for approved in [false, true] {
        let mut rounds = vec![call(
            "submit_plan",
            json!({"plan":"# Plan\nImplement and verify."}),
        )];
        if approved {
            rounds.push(answer("building"));
        }
        let fixture = Fixture::new(rounds);
        let redactor = Arc::new(Redactor::new(vec![]).unwrap());
        let mut host = fixture.host(redactor.clone()).await;
        let session = host
            .session(
                "session".into(),
                fixture.root.clone(),
                SessionKind::Interactive,
                true,
            )
            .unwrap();
        let interactions = host.interactions.get("session").unwrap();
        let mut receive = |event| {
            if let AgentEvent::ElicitationRequested {
                request_id,
                call_id,
                ..
            } = event
            {
                assert_eq!(call_id, "call");
                assert!(interactions.answer(
                    &request_id,
                    if approved {
                        Answers::Answered {
                            answers: vec![Answer {
                                question_id: "plan_review".into(),
                                value: "Approve and build".into(),
                            }],
                        }
                    } else {
                        Answers::Rejected
                    }
                )?);
            }
            Ok(())
        };
        let mut agent = Agent::new(
            &host,
            session,
            fixture.options("plan"),
            &redactor,
            Some(fixture.journal()),
            &mut receive,
        )
        .unwrap();
        let settings = xal_services::settings::Settings::parse(&JsonObject::new()).unwrap();
        agent.configure_modes(vec![(
            permissions::Permissions::load(&settings, &fixture.root, &fixture.root, "normal")
                .unwrap(),
            "Writable".into(),
        )]);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            agent.run(input("plan the work")),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(result, Outcome::Completed { .. }), "{result:?}");
        assert_eq!(agent.session().read_only, !approved);
        assert_eq!(
            agent.plan().unwrap().status == xal_services::workflows::PlanStatus::Approved,
            approved
        );
        assert_eq!(
            fixture.requests.lock().unwrap().len(),
            if approved { 2 } else { 1 }
        );
        drop(agent);
        host.shutdown().await;
    }
}

#[tokio::test]
async fn resumed_plan_dismissal_settles_the_cycle_without_another_provider_request() {
    let fixture = Fixture::new(vec![]);
    let redactor = Arc::new(Redactor::new(vec![]).unwrap());
    let mut host = fixture.host(redactor.clone()).await;
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Interactive,
            true,
        )
        .unwrap();
    let interactions = host.interactions.get("session").unwrap();
    let mut journal = fixture.journal();
    journal.append(&json!({"type":"item","item":{"type":"tool_call","callId":"pending-plan","name":"submit_plan","args":{"plan":"# Plan\nVerify work"}}})).unwrap();
    let loaded = journal.snapshot().unwrap();
    let mut ended = 0;
    let mut receive = |event| {
        match event {
            AgentEvent::ElicitationRequested { request_id, .. } => {
                interactions.answer(&request_id, Answers::Rejected)?;
            }
            AgentEvent::TurnEnded { .. } => ended += 1,
            _ => {}
        }
        Ok(())
    };
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("plan"),
        &redactor,
        Some(journal),
        &mut receive,
    )
    .unwrap();
    agent.restore_existing(&loaded).unwrap();
    assert!(matches!(
        agent.continue_turn(true).await.unwrap(),
        Outcome::Completed { .. }
    ));
    assert!(fixture.requests.lock().unwrap().is_empty());
    assert!(
        agent
            .snapshot()
            .unwrap()
            .events
            .iter()
            .any(|e| e["type"] == "turn_ended")
    );
    agent.close().await.unwrap();
    drop(agent);
    assert_eq!(ended, 1);
    host.shutdown().await;
}

#[tokio::test]
async fn failed_clear_closes_the_old_lifetime_and_removes_the_candidate_journal() {
    struct Disposer;
    impl Plugin for Disposer {
        fn name(&self) -> &str {
            "disposer"
        }
        fn register(&mut self, registration: &mut Registration) -> Result<()> {
            registration.session_disposer(Box::new(|_, context| {
                Box::pin(async move {
                    if context.session.id == "session" {
                        return Err(Error::Failed("fixture dispose failed".into()));
                    }
                    Ok(())
                })
            }));
            Ok(())
        }
    }
    let fixture = Fixture::new(vec![]);
    let redactor = Redactor::new(vec![]).unwrap();
    let mut host = Host::new(vec![Box::new(Disposer)], Cancellation::default());
    host.start().await.unwrap();
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Interactive,
            false,
        )
        .unwrap();
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    let before = std::fs::read(agent.journal().unwrap().path()).unwrap();
    let control = agent.control();
    assert!(
        agent
            .clear()
            .await
            .unwrap_err()
            .to_string()
            .contains("fixture dispose failed")
    );
    assert_eq!(agent.session().id, "session");
    assert_eq!(
        std::fs::read(agent.journal().unwrap().path()).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_dir(&fixture.root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|e| e == "jsonl"))
            .count(),
        1
    );
    assert_eq!(
        control.queue(input("unsafe continuation")),
        Err(Error::Cancelled)
    );
    assert_eq!(
        agent
            .run_turn(input("unsafe continuation"))
            .await
            .unwrap_err(),
        Error::Cancelled
    );
    assert_eq!(agent.clear().await.unwrap_err(), Error::Cancelled);
    drop(agent);
    host.shutdown().await;
}

#[tokio::test]
async fn failed_history_transition_retains_goal_and_conversation_together() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let fixture = Fixture::new(vec![answer("evidence")]);
    let redactor = Arc::new(Redactor::new(vec![]).unwrap());
    let mut host = fixture.host(redactor.clone()).await;
    let session = host
        .session(
            "session".into(),
            fixture.root.clone(),
            SessionKind::Interactive,
            false,
        )
        .unwrap();
    let fail = AtomicBool::new(false);
    let mut receive = |event| {
        if fail.load(Ordering::Acquire) && matches!(event, AgentEvent::GoalUpdated { .. }) {
            return Err(Error::Failed("fixture sink failed".into()));
        }
        Ok(())
    };
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    agent.run_turn(input("work")).await.unwrap();
    agent.start_goal("check the evidence").unwrap();
    let before = agent.snapshot().unwrap();
    let history = agent.history().to_vec();
    let bytes = std::fs::read(agent.journal().unwrap().path()).unwrap();
    let id = &before.conversation.checkpoints[0].message_id;
    fail.store(true, Ordering::Release);
    assert!(
        agent
            .rewind(id)
            .unwrap_err()
            .to_string()
            .contains("fixture sink failed")
    );
    assert_eq!(agent.snapshot().unwrap().records, before.records);
    assert_eq!(agent.history(), history);
    assert!(agent.goal().unwrap().active());
    assert_eq!(
        std::fs::read(agent.journal().unwrap().path()).unwrap(),
        bytes
    );
    fail.store(false, Ordering::Release);
    agent.rewind(id).unwrap();
    assert!(agent.history().is_empty());
    assert!(matches!(
        agent.goal().unwrap().status,
        GoalStatus::Suspended {
            suspension_cause: SuspensionCause::HistoryMovement,
            ..
        }
    ));
    agent.redo().unwrap();
    assert_eq!(agent.history(), history);
    agent.close().await.unwrap();
    drop(agent);
    host.shutdown().await;
}

#[tokio::test]
async fn failed_direct_shell_persistence_rolls_back_workspace_without_recording_a_message() {
    struct Shell;
    impl Plugin for Shell {
        fn name(&self) -> &str {
            "shell-fixture"
        }
        fn register(&mut self, r: &mut Registration) -> Result<()> {
            r.policy(
                "allow",
                Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
            )?;
            r.tool("bash", Tool {
                title: None, description: "fixture shell".into(),
                parameters: json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}).as_object().unwrap().clone(),
                effects: Effects::write, concurrency: None, permission_subject: None, redact: None,
                available: Box::new(|_| Ok(true)),
                run: Box::new(|_, context| Box::pin(async move {
                    std::fs::write(context.session.cwd.join("file.txt"), "agent work").unwrap();
                    Ok(ToolResult { output: "done".into() })
                })),
            })?;
            r.workspace_snapshots("bash", xal_host::undo::Scope::Workspace)
        }
    }
    let fixture = Fixture::new(vec![]);
    let cwd = fixture.root.join("work");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::write(cwd.join("file.txt"), "original").unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["add", "."],
        vec!["commit", "-qm", "initial"],
    ] {
        let result = std::process::Command::new("git")
            .args(args)
            .current_dir(&cwd)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let mut host = Host::new(vec![Box::new(Shell)], Cancellation::default());
    host.start().await.unwrap();
    let session = host
        .session(
            "session".into(),
            cwd.clone(),
            SessionKind::Interactive,
            false,
        )
        .unwrap();
    let redactor = Redactor::new(vec![]).unwrap();
    let mut receive = |event| {
        if matches!(event, AgentEvent::ShellFinished { .. }) {
            return Err(Error::Failed("fixture persistence failed".into()));
        }
        Ok(())
    };
    let mut agent = Agent::new(
        &host,
        session,
        fixture.options("normal"),
        &redactor,
        Some(fixture.journal()),
        &mut receive,
    )
    .unwrap();
    assert!(
        agent
            .direct_shell("!write fixture", "write fixture", None)
            .await
            .unwrap_err()
            .to_string()
            .contains("fixture persistence failed")
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("file.txt")).unwrap(),
        "original"
    );
    assert!(agent.history().is_empty());
    let loaded = agent.snapshot().unwrap();
    assert!(loaded.conversation.checkpoints.is_empty());
    assert!(
        !loaded
            .events
            .iter()
            .any(|event| event["type"] == "shell_finished")
    );
    agent.close().await.unwrap();
    drop(agent);
    host.shutdown().await;
}
