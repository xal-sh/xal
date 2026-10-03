use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use serde_json::json;
use tokio::sync::Notify;
use xal_host::agent::{Agent, AgentEvent, Input, Options, Outcome};
use xal_host::*;
use xal_services::redactor::Redactor;

struct Fixture {
    rounds: Arc<Mutex<VecDeque<Vec<ProviderEvent>>>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    started: Arc<Notify>,
    release: Arc<Notify>,
    pause: bool,
    pause_tool: bool,
    calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
    disposed: Arc<AtomicUsize>,
}

impl Fixture {
    fn new(rounds: Vec<Vec<ProviderEvent>>, pause: bool) -> Self {
        Self {
            rounds: Arc::new(Mutex::new(rounds.into())),
            requests: Arc::default(),
            started: Arc::default(),
            release: Arc::default(),
            pause,
            pause_tool: false,
            calls: Arc::default(),
            active: Arc::default(),
            maximum: Arc::default(),
            disposed: Arc::default(),
        }
    }
}

impl Plugin for Fixture {
    fn name(&self) -> &str {
        "fixture"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let rounds = self.rounds.clone();
        let requests = self.requests.clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let pause = self.pause;
        registration.provider("fixture", Provider { settle: None, models: vec!["fixture".into()], stream: Box::new(move |request, context, sender| {
            let rounds = rounds.clone();
            let requests = requests.clone();
            let started = started.clone();
            let release = release.clone();
            Box::pin(async move {
                let first = { let mut requests = requests.lock().unwrap(); requests.push(request); requests.len() == 1 };
                let events = rounds.lock().unwrap().pop_front().ok_or_else(|| Error::Failed("unexpected request".into()))?;
                for event in events { sender.send(event).await?; }
                if pause && first {
                    started.notify_one();
                    tokio::select! { () = context.cancellation.cancelled() => return Err(Error::Cancelled), () = release.notified() => {} }
                }
                Ok(())
            })
        }) })?;
        registration.policy(
            "allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.hook(
            "effective",
            Box::new(|input, _| {
                Box::pin(async move {
                    Ok(match input {
                        HookInput::Prompt { text } => {
                            HookResult::ReplacePrompt(format!("effective {text}"))
                        }
                        HookInput::BeforeTool { mut args, .. } => {
                            args.insert("effective".into(), json!(true));
                            HookResult::ReplaceArguments(args)
                        }
                        HookInput::AfterTool { output, .. } => {
                            assert!(!output.contains("secret-value"));
                            HookResult::ReplaceOutput(format!("{output} secret-value"))
                        }
                        HookInput::TurnEnd => HookResult::Continue,
                    })
                })
            }),
        )?;
        for (name, effects) in [
            ("read", Effects::read as fn(&JsonObject) -> Effects),
            ("write", Effects::write),
            ("shared_write", Effects::write),
        ] {
            let calls = self.calls.clone();
            let active = self.active.clone();
            let maximum = self.maximum.clone();
            let started = self.started.clone();
            let pause_tool = self.pause_tool;
            registration.tool(name, Tool { title: Some(Box::new(move |args, _| Ok(format!("{name} effective={} secret-value", args.get("effective").and_then(serde_json::Value::as_bool).unwrap_or(false))))), description: name.into(), parameters: json!({"type":"object","properties":{"effective":{"const":true}},"required":["effective"]}).as_object().unwrap().clone(), effects, concurrency: if name == "shared_write" { Some(|_| Concurrency::Shared) } else { None }, permission_subject: None, redact: None, available: Box::new(|_| Ok(true)), run: Box::new(move |args, context| {
                let calls = calls.clone(); let active = active.clone(); let maximum = maximum.clone(); let started = started.clone();
                Box::pin(async move {
                    assert_eq!(args["effective"], true);
                    if pause_tool && name == "read" {
                        started.notify_one();
                        context.cancellation.cancelled().await;
                        return Err(Error::Cancelled);
                    }
                    if name == "write" { assert_eq!(active.load(Ordering::SeqCst), 0); }
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(count, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    if let Some(output) = context.output { output.send("first ".repeat(20)).await?; output.send("secret-".into()).await?; output.send("value tail".into()).await?; output.send("last ".repeat(20)).await?; }
                    active.fetch_sub(1, Ordering::SeqCst);
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ToolResult { output: "secret-value tool output".into() })
                })
            }) })?;
        }
        let disposed = self.disposed.clone();
        registration.session_disposer(Box::new(move |_, _| {
            let disposed = disposed.clone();
            Box::pin(async move {
                disposed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }));
        Ok(())
    }
}

fn options() -> Options {
    Options {
        provider: "fixture".into(),
        profile: None,
        model: "fixture".into(),
        mode: "normal".into(),
        instructions: "instructions".into(),
        thinking: None,
        context_window: 10000,
        image_input: false,
        summary_target: None,
        compaction_limit: None,
        output_schema: None,
        artifacts: std::env::temp_dir().join("unused-agent-test-artifacts"),
    }
}
fn call(id: &str, name: &str) -> ProviderEvent {
    ProviderEvent::Item(Item::ToolCall {
        call_id: id.into(),
        name: name.into(),
        args: JsonObject::new(),
        replay: Some(Replay {
            provider: "fixture".into(),
            model: None,
            data: json!({"original":true}).as_object().unwrap().clone(),
        }),
    })
}
fn done() -> ProviderEvent {
    ProviderEvent::Done { usage: None }
}
fn answer(text: &str) -> Vec<ProviderEvent> {
    vec![
        ProviderEvent::TextDelta(text.into()),
        ProviderEvent::Item(Item::AssistantMessage {
            text: text.into(),
            replay: None,
        }),
        done(),
    ]
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        images: Vec::new(),
    }
}

#[tokio::test]
async fn effective_hooks_concurrent_reads_exclusive_writes_and_redacted_output() {
    let fixture = Fixture::new(
        vec![
            vec![
                call("one", "read"),
                call("two", "read"),
                call("three", "write"),
                done(),
            ],
            answer("finished"),
        ],
        false,
    );
    let requests = fixture.requests.clone();
    let maximum = fixture.maximum.clone();
    let disposed = fixture.disposed.clone();
    let mut host = Host::new(vec![Box::new(fixture)], Cancellation::default());
    let redactor = Arc::new(Redactor::new(vec!["secret-value".into()]).unwrap());
    host.output_policy(
        redactor.clone(),
        std::env::temp_dir().join("unused-agent-test-artifacts"),
    );
    host.start().await.unwrap();
    let session = host
        .session("test".into(), ".".into(), SessionKind::Headless, false)
        .unwrap();
    let mut events = Vec::new();
    let mut receive = |event| {
        events.push(event);
        Ok(())
    };
    let mut agent = Agent::new(&host, session, options(), &redactor, None, &mut receive).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(2), agent.run(input("authored")))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(outcome, Outcome::Completed { .. }));
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    assert_eq!(disposed.load(Ordering::SeqCst), 1);
    {
        let requests = requests.lock().unwrap();
        assert!(
            matches!(&requests[0].input[0], Item::UserMessage { text, model_text: None, .. } if text == "effective authored")
        );
        for item in &requests[1].input {
            if let Item::ToolCall { args, replay, .. } = item {
                assert_eq!(args["effective"], true);
                assert!(replay.is_none());
            }
        }
    }
    for event in &events {
        if let AgentEvent::ToolStarted { tool, title, .. }
        | AgentEvent::ToolFinished { tool, title, .. } = event
        {
            assert_eq!(title, &format!("{tool} effective=true [REDACTED]"));
        }
    }
    for id in ["one", "two", "three"] {
        let finished = events
            .iter()
            .position(
                |event| matches!(event, AgentEvent::ToolFinished { call_id, .. } if call_id == id),
            )
            .unwrap();
        let mut text = String::new();
        let mut chunks = 0;
        for (index, event) in events.iter().enumerate() {
            if let AgentEvent::ToolUpdated {
                call_id,
                text: delta,
            } = event
                && call_id == id
            {
                assert!(index < finished, "progress followed tool completion");
                text.push_str(delta);
                chunks += 1;
            }
        }
        assert!(chunks > 1);
        assert_eq!(
            text,
            format!(
                "{}[REDACTED] tail{}",
                "first ".repeat(20),
                "last ".repeat(20)
            )
        );
    }
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("secret-value")
    );
    host.shutdown().await;
}

#[tokio::test]
async fn explicit_shared_scheduling_preserves_write_permissions() {
    let fixture = Fixture::new(
        vec![
            vec![
                call("one", "shared_write"),
                call("two", "shared_write"),
                done(),
            ],
            answer("finished"),
        ],
        false,
    );
    let maximum = fixture.maximum.clone();
    let redactor = Arc::new(Redactor::new(vec!["secret-value".into()]).unwrap());
    let mut host = Host::new(vec![Box::new(fixture)], Cancellation::default());
    host.output_policy(redactor.clone(), options().artifacts);
    host.start().await.unwrap();
    let session = host
        .session("test".into(), ".".into(), SessionKind::Headless, false)
        .unwrap();
    assert!(matches!(
        host.prepare_tool(
            "shared_write",
            JsonObject::new(),
            &Session {
                read_only: true,
                ..session.clone()
            },
        )
        .await,
        Err(Error::Denied(_))
    ));
    let mut events = Vec::new();
    let mut receive = |event| {
        events.push(event);
        Ok(())
    };
    let mut agent = Agent::new(&host, session, options(), &redactor, None, &mut receive).unwrap();
    assert!(matches!(
        agent.run(input("authored")).await.unwrap(),
        Outcome::Completed { .. }
    ));
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    for event in events {
        if let AgentEvent::ToolStarted { read_only, .. } = event {
            assert!(!read_only);
        }
    }
    host.shutdown().await;
    assert!(host.failures().is_empty());
}

#[tokio::test]
async fn queue_steer_and_hard_interrupt_settle_before_cleanup() {
    for action in ["queue", "steer", "interrupt"] {
        let mut initial = vec![
            ProviderEvent::TextDelta("partial".into()),
            call("pending", "write"),
        ];
        if action == "queue" {
            initial.push(done());
        }
        let fixture = Fixture::new(
            vec![initial, answer("queued answer"), answer("resumed")],
            true,
        );
        let started = fixture.started.clone();
        let release = fixture.release.clone();
        let disposed = fixture.disposed.clone();
        let calls = fixture.calls.clone();
        let requests = fixture.requests.clone();
        let mut host = Host::new(vec![Box::new(fixture)], Cancellation::default());
        let redactor = Arc::new(Redactor::new(vec!["secret-value".into()]).unwrap());
        host.output_policy(
            redactor.clone(),
            std::env::temp_dir().join("unused-agent-test-artifacts"),
        );
        host.start().await.unwrap();
        let session = host
            .session("test".into(), ".".into(), SessionKind::Headless, false)
            .unwrap();
        let mut events = Vec::new();
        let mut receive = |event| {
            events.push(event);
            Ok(())
        };
        let mut agent =
            Agent::new(&host, session, options(), &redactor, None, &mut receive).unwrap();
        let control = agent.control();
        let driver = async {
            started.notified().await;
            match action {
                "queue" => {
                    control.queue(input("queued")).unwrap();
                    release.notify_one();
                }
                "steer" => control.steer("steered".into()).unwrap(),
                "interrupt" => control.interrupt(),
                _ => unreachable!(),
            }
        };
        let (outcome, ()) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(agent.run(input("original")), driver)
        })
        .await
        .unwrap();
        let outcome = outcome.unwrap();
        assert_eq!(
            outcome.exit_code(),
            if action == "interrupt" { 130 } else { 0 },
            "{action}: {outcome:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(action == "queue"));
        assert_eq!(disposed.load(Ordering::SeqCst), 1);
        assert!(control.queue(input("late")).is_err());
        if action != "interrupt" {
            assert!(requests.lock().unwrap()[1].input.iter().any(
                |item| matches!(item, Item::ToolResult { call_id, .. } if call_id == "pending")
            ));
        }
        host.shutdown().await;
    }
}

#[tokio::test]
async fn sink_failure_still_disposes_session_resources() {
    let fixture = Fixture::new(vec![answer("answer")], false);
    let disposed = fixture.disposed.clone();
    let mut host = Host::new(vec![Box::new(fixture)], Cancellation::default());
    host.start().await.unwrap();
    let redactor = Redactor::new(Vec::new()).unwrap();
    let session = host
        .session("test".into(), ".".into(), SessionKind::Headless, false)
        .unwrap();
    let mut receive = |_| Err(Error::Failed("broken pipe".into()));
    let mut agent = Agent::new(&host, session, options(), &redactor, None, &mut receive).unwrap();
    assert!(agent.run(input("prompt")).await.is_err());
    assert_eq!(disposed.load(Ordering::SeqCst), 1);
    host.shutdown().await;
}

#[tokio::test]
async fn steering_during_a_tool_batch_pairs_every_pending_call_before_resuming() {
    let mut fixture = Fixture::new(
        vec![
            vec![
                call("slow", "read"),
                call("pending-output", "submit_output"),
                call("pending-write", "write"),
                done(),
            ],
            vec![call("final", "submit_output"), done()],
        ],
        false,
    );
    fixture.pause_tool = true;
    let started = fixture.started.clone();
    let requests = fixture.requests.clone();
    let calls = fixture.calls.clone();
    let mut host = Host::new(vec![Box::new(fixture)], Cancellation::default());
    host.start().await.unwrap();
    let redactor = Redactor::new(Vec::new()).unwrap();
    let session = host
        .session("test".into(), ".".into(), SessionKind::Headless, false)
        .unwrap();
    let mut options = options();
    options.output_schema = Some(json!({"type":"object"}).as_object().unwrap().clone());
    let mut receive = |_| Ok(());
    let mut agent = Agent::new(&host, session, options, &redactor, None, &mut receive).unwrap();
    let control = agent.control();
    let (outcome, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(agent.run(input("original")), async {
            started.notified().await;
            control.steer("change direction".into()).unwrap();
        })
    })
    .await
    .unwrap();
    assert!(matches!(outcome.unwrap(), Outcome::Completed { .. }));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for id in ["slow", "pending-output", "pending-write"] {
            assert_eq!(
                requests[1]
                    .input
                    .iter()
                    .filter(
                        |item| matches!(item, Item::ToolResult { call_id, .. } if call_id == id)
                    )
                    .count(),
                1,
                "unpaired {id}"
            );
        }
    }
    host.shutdown().await;
}

struct Loud;
impl Plugin for Loud {
    fn name(&self) -> &str {
        "loud"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.policy(
            "allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.tool(
            "loud",
            Tool {
                title: None,
                description: "loud".into(),
                parameters: JsonObject::new(),
                effects: Effects::read,
                concurrency: None,
                permission_subject: None,
                redact: None,
                available: Box::new(|_| Ok(true)),
                run: Box::new(|_, context| {
                    Box::pin(async move {
                        let output = context.output.unwrap();
                        output.send("first".into()).await?;
                        output.send("a".into()).await?;
                        Ok(ToolResult {
                            output: "done".into(),
                        })
                    })
                }),
            },
        )
    }
}

#[tokio::test]
async fn saturated_output_and_redactor_tail_remain_cancellable() {
    for secrets in [Vec::new(), vec!["abcd".into()]] {
        let mut host = Host::new(vec![Box::new(Loud)], Cancellation::default());
        host.output_policy(
            Arc::new(Redactor::new(secrets).unwrap()),
            std::env::temp_dir().join("unused-agent-test-artifacts"),
        );
        host.start().await.unwrap();
        let session = host
            .session("test".into(), ".".into(), SessionKind::Headless, false)
            .unwrap();
        let prepared = host
            .prepare_tool("loud", JsonObject::new(), &session)
            .await
            .unwrap();
        let (output, receiver) = channel(1, Cancellation::default()).unwrap();
        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                host.execute_tool_streaming(prepared, &session, Some(output)),
                async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    session.cancellation.cancel();
                }
            )
        })
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), Error::Cancelled);
        drop(receiver);
        host.shutdown().await;
    }
}

struct Stuck;
impl Plugin for Stuck {
    fn name(&self) -> &str {
        "stuck"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.policy(
            "allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.tool(
            "stuck",
            Tool {
                title: None,
                description: "stuck".into(),
                parameters: JsonObject::new(),
                effects: Effects::read,
                concurrency: None,
                permission_subject: None,
                redact: None,
                available: Box::new(|_| Ok(true)),
                run: Box::new(|_, context| {
                    Box::pin(async move {
                        context.cancellation.cancelled().await;
                        std::future::pending::<()>().await;
                        drop(context);
                        unreachable!()
                    })
                }),
            },
        )
    }
}

#[tokio::test]
async fn uncooperative_cancelled_tool_is_bounded_and_reports_failure() {
    let mut host = Host::new(vec![Box::new(Stuck)], Cancellation::default());
    host.start().await.unwrap();
    let session = host
        .session("test".into(), ".".into(), SessionKind::Headless, false)
        .unwrap();
    let prepared = host
        .prepare_tool("stuck", JsonObject::new(), &session)
        .await
        .unwrap();
    let (output, _receiver) = channel(1, Cancellation::default()).unwrap();
    let (result, ()) = tokio::join!(
        host.execute_tool_streaming(prepared, &session, Some(output)),
        async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            session.cancellation.cancel();
        }
    );
    assert!(matches!(result, Err(Error::Failed(message)) if message.contains("did not settle")));
    host.shutdown().await;
}
