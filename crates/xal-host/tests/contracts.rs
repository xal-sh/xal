use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use xal_host::*;

struct Capabilities {
    decision: PolicyDecision,
    fail: bool,
    receiver: Arc<Mutex<Option<Receiver<Event>>>>,
    disposed: Arc<AtomicBool>,
}

impl Plugin for Capabilities {
    fn name(&self) -> &str {
        "capabilities"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        *self.receiver.lock().unwrap() = Some(registration.subscribe(1)?);
        let disposed = self.disposed.clone();
        registration.own(move || {
            disposed.store(true, Ordering::Release);
            Ok(())
        });
        registration.tool(
            "read",
            Tool {
                description: "read".into(),
                parameters: JsonObject::new(),
                read_only: true,
                run: Box::new(|args, _| {
                    Box::pin(async move {
                        Ok(ToolResult {
                            output: args
                                .get("text")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("safe")
                                .into(),
                        })
                    })
                }),
            },
        )?;
        registration.tool(
            "write",
            Tool {
                description: "write".into(),
                parameters: JsonObject::new(),
                read_only: false,
                run: Box::new(|_, _| Box::pin(async { panic!("must not execute denied tool") })),
            },
        )?;
        let decision = self.decision.clone();
        registration.policy(
            "guard",
            Box::new(move |_, _| {
                let decision = decision.clone();
                Box::pin(async move { Ok(decision) })
            }),
        )?;
        registration.policy(
            "later-allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.hook(
            "rewrite",
            Box::new(|input, _| {
                Box::pin(async move {
                    Ok(match input {
                        HookInput::BeforeTool { .. } => HookResult::ReplaceArguments(
                            json!({"text":"rewritten"}).as_object().unwrap().clone(),
                        ),
                        HookInput::Prompt { text } => HookResult::ReplacePrompt(text),
                        HookInput::AfterTool { .. } | HookInput::TurnEnd => HookResult::Continue,
                    })
                })
            }),
        )?;
        registration.prompt("instructions", "read only".into())?;
        registration.ui(
            "plain",
            Box::new(|contribution, _| {
                Box::pin(async move {
                    Ok(match contribution {
                        UiContribution::Text { text } => text,
                        UiContribution::Status { label, value } => format!("{label}: {value}"),
                        UiContribution::Tool { name, output } => format!("{name}: {output}"),
                    })
                })
            }),
        )?;
        registration.provider(
            "local",
            Provider {
                models: vec!["local".into()],
                stream: Box::new(|request, _, output| {
                    Box::pin(async move {
                        output.send(ProviderEvent::TextDelta(request.input)).await?;
                        output
                            .send(ProviderEvent::Done {
                                input_tokens: None,
                                output_tokens: None,
                            })
                            .await
                    })
                }),
            },
        )?;
        registration.decision(
            "local",
            Box::new(|_, _| Box::pin(async { Ok(DecisionResponse::new()) })),
        )?;
        if self.fail {
            panic!("registration failure")
        }
        Ok(())
    }
}

#[tokio::test]
async fn all_capabilities_are_staged_and_failed_owner_loses_subscriptions_and_resources() {
    let receiver = Arc::new(Mutex::new(None));
    let disposed = Arc::new(AtomicBool::new(false));
    let mut host = Host::new(
        vec![Box::new(Capabilities {
            decision: PolicyDecision::Allow,
            fail: true,
            receiver: receiver.clone(),
            disposed: disposed.clone(),
        })],
        Cancellation::default(),
    );
    assert!(host.start().await.is_err());
    assert!(disposed.load(Ordering::Acquire));
    let mut receiver = receiver.lock().unwrap().take().unwrap();
    assert_eq!(receiver.recv().await, Err(Error::Cancelled));
    assert!(host.prompts().unwrap().is_empty());
    let session = host
        .session("s".into(), ".".into(), SessionKind::Headless, true)
        .unwrap();
    assert!(
        host.tool("read", JsonObject::new(), &session)
            .await
            .is_err()
    );
    assert!(
        host.render("plain", UiContribution::Text { text: "x".into() }, &session)
            .await
            .is_err()
    );
    host.shutdown().await;
}

#[tokio::test]
async fn policies_cannot_override_denials_or_read_only_and_hooks_run_before_policy() {
    for decision in [
        PolicyDecision::Allow,
        PolicyDecision::Deny("denied".into()),
        PolicyDecision::Ask("ask".into()),
    ] {
        let receiver = Arc::new(Mutex::new(None));
        let mut host = Host::new(
            vec![Box::new(Capabilities {
                decision: decision.clone(),
                fail: false,
                receiver: receiver.clone(),
                disposed: Arc::new(AtomicBool::new(false)),
            })],
            Cancellation::default(),
        );
        host.start().await.unwrap();
        let session = host
            .session("s".into(), ".".into(), SessionKind::Headless, true)
            .unwrap();
        let output = host.tool("read", JsonObject::new(), &session).await;
        match decision {
            PolicyDecision::Allow => {
                assert_eq!(output.unwrap().output, "rewritten");
                assert!(
                    host.publish(Event::SessionStarted { id: "full".into() })
                        .is_err()
                );
                let mut events = receiver.lock().unwrap().take().unwrap();
                assert!(matches!(
                    events.recv().await.unwrap(),
                    Some(Event::ToolFinished { .. })
                ));
                *receiver.lock().unwrap() = Some(events);
            }
            PolicyDecision::Deny(reason) => assert_eq!(output, Err(Error::Denied(reason))),
            PolicyDecision::Ask(reason) => assert_eq!(output, Err(Error::ApprovalRequired(reason))),
            PolicyDecision::Abstain => unreachable!(),
        }
        assert!(matches!(
            host.tool("write", JsonObject::new(), &session).await,
            Err(Error::Denied(_))
        ));
        host.shutdown().await;
    }
}

#[tokio::test]
async fn provider_stream_backpressure_cancellation_and_session_isolation() {
    let receiver = Arc::new(Mutex::new(None));
    let mut host = Host::new(
        vec![Box::new(Capabilities {
            decision: PolicyDecision::Allow,
            fail: false,
            receiver,
            disposed: Arc::new(AtomicBool::new(false)),
        })],
        Cancellation::default(),
    );
    host.start().await.unwrap();
    let session = host
        .session("a".into(), ".".into(), SessionKind::Headless, true)
        .unwrap();
    let other = host
        .session("b".into(), ".".into(), SessionKind::Headless, true)
        .unwrap();
    let (sender, mut stream) = channel(1, session.cancellation.clone()).unwrap();
    let request = ProviderRequest {
        model: "local".into(),
        instructions: host.prompts().unwrap().join("\n"),
        input: "hello".into(),
        profile: None,
    };
    let (result, events) = tokio::join!(host.provider("local", request, &session, sender), async {
        let first = stream.recv().await.unwrap();
        let last = stream.recv().await.unwrap();
        (first, last)
    });
    result.unwrap();
    assert_eq!(events.0, Some(ProviderEvent::TextDelta("hello".into())));
    assert!(matches!(events.1, Some(ProviderEvent::Done { .. })));
    let (sender, mut stream) = channel(1, session.cancellation.clone()).unwrap();
    sender.send(1).await.unwrap();
    let (result, ()) = tokio::join!(sender.send(2), async {
        tokio::task::yield_now().await;
        session.cancellation.cancel();
    });
    assert_eq!(result, Err(Error::Cancelled));
    assert_eq!(stream.recv().await, Err(Error::Cancelled));
    other.cancellation.check().unwrap();
    host.shutdown().await;
    assert_eq!(other.cancellation.check(), Err(Error::Cancelled));
}

struct Waiting {
    task_dropped: Arc<AtomicBool>,
}
struct Owned(Arc<AtomicBool>);
impl Drop for Owned {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
impl Plugin for Waiting {
    fn name(&self) -> &str {
        "waiting"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let owned = Owned(self.task_dropped.clone());
        registration.spawn(async move {
            let _owned = owned;
            std::future::pending::<Result<()>>().await
        })
    }
    fn bootstrap<'a>(&'a mut self, _: &'a mut Registration) -> Call<'a, ()> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn cancellation_interrupts_pending_bootstrap_and_joins_owned_tasks() {
    let cancellation = Cancellation::default();
    let dropped = Arc::new(AtomicBool::new(false));
    let mut host = Host::new(
        vec![Box::new(Waiting {
            task_dropped: dropped.clone(),
        })],
        cancellation.clone(),
    );
    let (result, ()) = tokio::join!(host.start(), async {
        tokio::task::yield_now().await;
        cancellation.cancel();
    });
    assert_eq!(result, Err(Error::Cancelled));
    assert!(dropped.load(Ordering::Acquire));
    assert!(host.commands().is_empty());
    host.shutdown().await;
}

struct OrderedHooks {
    name: &'static str,
    hooks: &'static [&'static str],
}

impl Plugin for OrderedHooks {
    fn name(&self) -> &str {
        self.name
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        for &name in self.hooks {
            registration.hook(
                name,
                Box::new(move |input, _| {
                    Box::pin(async move {
                        Ok(match input {
                            HookInput::Prompt { text } => {
                                HookResult::ReplacePrompt(format!("{text}/{name}"))
                            }
                            HookInput::BeforeTool { mut args, .. } => {
                                let text = args.get("text").unwrap().as_str().unwrap();
                                args.insert("text".into(), json!(format!("{text}/{name}")));
                                HookResult::ReplaceArguments(args)
                            }
                            HookInput::AfterTool { .. } | HookInput::TurnEnd => {
                                HookResult::Continue
                            }
                        })
                    })
                }),
            )?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn replacement_hooks_preserve_owner_and_registration_order() {
    let mut host = Host::new(
        vec![
            Box::new(OrderedHooks {
                name: "z-owner",
                hooks: &["z-first", "a-second"],
            }),
            Box::new(OrderedHooks {
                name: "a-owner",
                hooks: &["b-third"],
            }),
        ],
        Cancellation::default(),
    );
    host.start().await.unwrap();
    let session = host
        .session("s".into(), ".".into(), SessionKind::Headless, true)
        .unwrap();
    assert_eq!(
        host.hook(
            HookInput::Prompt {
                text: "start".into()
            },
            &session
        )
        .await
        .unwrap(),
        HookInput::Prompt {
            text: "start/z-first/a-second/b-third".into()
        }
    );
    assert_eq!(
        host.hook(
            HookInput::BeforeTool {
                tool: "read".into(),
                args: json!({"text": "start"}).as_object().unwrap().clone(),
            },
            &session,
        )
        .await
        .unwrap(),
        HookInput::BeforeTool {
            tool: "read".into(),
            args: json!({"text": "start/z-first/a-second/b-third"})
                .as_object()
                .unwrap()
                .clone(),
        }
    );
    host.shutdown().await;
}

struct CancelCallback;
impl Plugin for CancelCallback {
    fn name(&self) -> &str {
        "cancel-callback"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.ui(
            "cancel",
            Box::new(|_, context| {
                Box::pin(async move {
                    context.cancellation.cancel();
                    Ok("must not succeed".into())
                })
            }),
        )?;
        registration.provider(
            "cancel",
            Provider {
                models: vec!["cancel".into()],
                stream: Box::new(|_, context, _| {
                    Box::pin(async move {
                        context.cancellation.cancel();
                        Ok(())
                    })
                }),
            },
        )
    }
}

#[tokio::test]
async fn callback_local_cancellation_cannot_report_success_or_cancel_other_calls() {
    let mut host = Host::new(vec![Box::new(CancelCallback)], Cancellation::default());
    host.start().await.unwrap();
    let session = host
        .session("s".into(), ".".into(), SessionKind::Headless, true)
        .unwrap();
    assert_eq!(
        host.render(
            "cancel",
            UiContribution::Text { text: "x".into() },
            &session
        )
        .await,
        Err(Error::Cancelled)
    );
    let (sender, _) = channel(1, session.cancellation.clone()).unwrap();
    assert_eq!(
        host.provider(
            "cancel",
            ProviderRequest {
                model: "cancel".into(),
                instructions: String::new(),
                input: String::new(),
                profile: None
            },
            &session,
            sender
        )
        .await,
        Err(Error::Cancelled)
    );
    session.cancellation.check().unwrap();
    host.shutdown().await;
}
