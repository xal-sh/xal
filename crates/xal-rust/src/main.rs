mod accounts;
mod headless;
mod integrations;
mod prompt;

use std::env;
use std::future::Future;
use std::io::{self, Write};
use std::process::ExitCode;

use xal_host::*;

async fn run(args: &[String]) -> Result<String> {
    if args == ["--version"] || args == ["-v"] {
        return Ok(format!(
            "xal-rust {} (development)\n",
            env!("CARGO_PKG_VERSION")
        ));
    }
    let cancellation = Cancellation::default();
    let mut host = Host::new(
        vec![
            Box::new(xal_plugin_inspect::Inspect),
            Box::new(xal_plugin_diagnostics::Diagnostics),
        ],
        cancellation.clone(),
    );
    run_host(&mut host, args, &cancellation, tokio::signal::ctrl_c()).await
}

async fn run_host(
    host: &mut Host,
    args: &[String],
    cancellation: &Cancellation,
    interrupt: impl Future<Output = io::Result<()>>,
) -> Result<String> {
    let output = {
        let operation = async {
            host.start().await?;
            dispatch(host, args).await
        };
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => result,
            signal = interrupt => {
                cancellation.cancel();
                let signal = match signal {
                    Ok(()) => Error::Cancelled,
                    Err(error) => Error::Failed(format!("cannot listen for interruption: {error}")),
                };
                match operation.await {
                    Ok(_) | Err(Error::Cancelled) => Err(signal),
                    Err(error) => Err(Error::Failed(format!("{signal}\n{error}"))),
                }
            }
        }
    };
    host.shutdown().await;
    host_result(host, output)
}

fn host_result(host: &Host, output: Result<String>) -> Result<String> {
    let failures = host
        .failures()
        .iter()
        .filter(|failure| {
            !(output == Err(Error::Cancelled)
                && matches!(failure.phase, Phase::Register | Phase::Bootstrap)
                && failure.error == Error::Cancelled)
        })
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    if !failures.is_empty() {
        return Err(Error::Failed(match output {
            Err(error) => format!("{error}\n{failures}"),
            Ok(_) => failures,
        }));
    }
    output
}

async fn dispatch(host: &Host, args: &[String]) -> Result<String> {
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        let mut help = String::from(
            "xal-rust — native foundation (development only)\n\nUsage: xal-rust <command>\n\n  --version  Print the development version\n  --help     Show this help\n  host-check  Run a local typed host diagnostic (no network or writes)\n",
        );
        for (name, description) in host.commands() {
            help.push_str(&format!("  {name}  {description}\n"));
        }
        help.push_str("  run [options] [prompt]  Run a native headless session\n  connect / connections / profiles / rename / logout  Manage named connections\n  usage  Read provider request usage totals\n  models / model / thinking / context-window / compaction-limit  Configure text models\n  typesafe on|off  Configure decision inference\n  mcp / lsp  Inspect or manage native integrations\n  commands / prompt / review  List commands or preview prepared prompts\n  workspace-paths [query]  Rank workspace completion paths\n\nUse <command> --help for account options. No TUI yet. Use xal for the current application.\n");
        return Ok(help);
    }
    if args == ["host-check"] {
        return host_check(host).await;
    }
    host.execute(&args[0], &args[1..]).await
}

async fn host_check(host: &Host) -> Result<String> {
    let session = host.session(
        "foundation-check".into(),
        env::current_dir().map_err(|error| Error::Failed(error.to_string()))?,
        SessionKind::Headless,
        true,
    )?;
    host.publish(Event::SessionStarted {
        id: session.id.clone(),
    })?;
    let report = host
        .tool("config-inspect", JsonObject::new(), &session)
        .await?;
    let HookInput::Prompt { text } = host
        .hook(
            HookInput::Prompt {
                text: report.output,
            },
            &session,
        )
        .await?
    else {
        return Err(Error::Failed("invalid diagnostic hook result".into()));
    };
    let decisions = host
        .decide(
            "diagnostic",
            DecisionRequest {
                model: "local-report".into(),
                state: serde_json::Value::String(text.clone()),
                questions: [(
                    "available".into(),
                    DecisionQuestion::Noul {
                        instructions: serde_json::Value::Null,
                        criteria: None,
                    },
                )]
                .into(),
            },
            &session,
        )
        .await?;
    if decisions.answers.get("available") != Some(&DecisionAnswer::Noul { noul: 1.0 }) {
        return Err(Error::Failed("diagnostic report unavailable".into()));
    }
    let (sender, mut receiver) = channel(2, session.cancellation.clone())?;
    let request = ProviderRequest {
        model: "local-report".into(),
        instructions: host.prompts()?.join("\n"),
        input: vec![Item::user(text)],
        profile: None,
        tools: Vec::new(),
        thinking: None,
        cache_key: String::new(),
        session_id: String::new(),
        phase: xal_host::recording::Phase::Turn,
        attempt: 1,
    };
    let (provider, output) = tokio::join!(
        host.provider("diagnostic", request, &session, sender),
        async {
            let mut text = String::new();
            let mut finished = false;
            while let Some(event) = receiver.recv().await? {
                match event {
                    ProviderEvent::TextDelta(delta) if !finished => text.push_str(&delta),
                    ProviderEvent::Done { .. } if !finished => finished = true,
                    ProviderEvent::TextDelta(_)
                    | ProviderEvent::Usage(_)
                    | ProviderEvent::Done { .. }
                    | ProviderEvent::ReasoningDelta(_)
                    | ProviderEvent::Item(_)
                    | ProviderEvent::ReasoningSummaryDelta(_) => {
                        return Err(Error::Failed("unexpected diagnostic stream event".into()));
                    }
                }
            }
            if !finished {
                return Err(Error::Failed(
                    "diagnostic stream ended before completion".into(),
                ));
            }
            Ok(text)
        }
    );
    provider?;
    host.hook(HookInput::TurnEnd, &session).await?;
    host.render("plain", UiContribution::Text { text: output? }, &session)
        .await
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect::<std::result::Result<Vec<_>, _>>()
    {
        Ok(args) => args,
        Err(_) => {
            eprintln!("xal-rust: arguments must be valid Unicode");
            return ExitCode::FAILURE;
        }
    };
    if args
        .first()
        .is_some_and(|arg| arg == "run" || accounts::handles(arg))
    {
        return match if args[0] == "run" {
            headless::run(&args[1..]).await
        } else {
            accounts::run(&args).await
        } {
            Ok(code) => ExitCode::from(code),
            Err(error) => {
                eprintln!("xal-rust: {error}");
                ExitCode::FAILURE
            }
        };
    }
    let result = if args
        .first()
        .is_some_and(|command| integrations::handles(command))
    {
        integrations::run(&args).await
    } else {
        run(&args).await.map(|output| (output, 0))
    };
    match result {
        Ok((output, code)) => match io::stdout().lock().write_all(output.as_bytes()) {
            Ok(()) => ExitCode::from(code),
            Err(error) => {
                eprintln!("xal-rust: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("xal-rust: {error}");
            match error {
                Error::Cancelled => ExitCode::from(130),
                Error::Failed(_)
                | Error::Denied(_)
                | Error::ApprovalRequired(_)
                | Error::Provider { .. } => ExitCode::FAILURE,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::*;

    struct Failed {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        disposed: Arc<AtomicBool>,
    }

    impl Plugin for Failed {
        fn name(&self) -> &str {
            "failed"
        }
        fn register(&mut self, registration: &mut Registration) -> Result<()> {
            let entered = self.entered.clone();
            let release = self.release.clone();
            let disposed = self.disposed.clone();
            registration.own_async(move || {
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    disposed.store(true, Ordering::Release);
                    Ok(())
                })
            });
            Err(Error::Failed("fixture registration failure".into()))
        }
    }

    #[tokio::test]
    async fn interrupted_rollback_waits_for_async_disposer() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let disposed = Arc::new(AtomicBool::new(false));
        let cancellation = Cancellation::default();
        let mut host = Host::new(
            vec![Box::new(Failed {
                entered: entered.clone(),
                release: release.clone(),
                disposed: disposed.clone(),
            })],
            cancellation.clone(),
        );
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_host(&mut host, &[], &cancellation, async {
                entered.notified().await;
                release.notify_one();
                Ok(())
            }),
        )
        .await
        .unwrap();
        assert!(disposed.load(Ordering::Acquire));
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("fixture registration failure")
        );
        assert_eq!(host.failures().len(), 1);
        assert_eq!(cancellation.check(), Err(Error::Cancelled));
        assert!(host.commands().is_empty());
    }

    struct Waiting {
        entered: Arc<Notify>,
        disposed: Arc<AtomicBool>,
        cleanup_error: Option<Error>,
    }

    impl Plugin for Waiting {
        fn name(&self) -> &str {
            "waiting"
        }
        fn register(&mut self, registration: &mut Registration) -> Result<()> {
            let disposed = self.disposed.clone();
            let error = self.cleanup_error.clone();
            registration.own(move || {
                disposed.store(true, Ordering::Release);
                error.map_or(Ok(()), Err)
            });
            Ok(())
        }
        fn bootstrap<'a>(&'a mut self, _: &'a mut Registration) -> Call<'a, ()> {
            Box::pin(async move {
                self.entered.notify_one();
                std::future::pending().await
            })
        }
    }

    #[tokio::test]
    async fn startup_interruption_preserves_cancellation_but_reports_cleanup_errors() {
        for cleanup_error in [
            None,
            Some(Error::Cancelled),
            Some(Error::Failed("cleanup failure".into())),
        ] {
            let entered = Arc::new(Notify::new());
            let disposed = Arc::new(AtomicBool::new(false));
            let cancellation = Cancellation::default();
            let mut host = Host::new(
                vec![Box::new(Waiting {
                    entered: entered.clone(),
                    disposed: disposed.clone(),
                    cleanup_error: cleanup_error.clone(),
                })],
                cancellation.clone(),
            );
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                run_host(&mut host, &[], &cancellation, async {
                    entered.notified().await;
                    Ok(())
                }),
            )
            .await
            .unwrap();
            assert!(disposed.load(Ordering::Acquire));
            assert_eq!(host.failures()[0].phase, Phase::Bootstrap);
            assert_eq!(host.failures()[0].error, Error::Cancelled);
            match cleanup_error {
                None => assert_eq!(result, Err(Error::Cancelled)),
                Some(error) => {
                    assert!(matches!(result, Err(Error::Failed(_))));
                    assert_eq!(host.failures()[1].phase, Phase::Dispose);
                    assert_eq!(host.failures()[1].error, error);
                    let message = result.unwrap_err().to_string();
                    assert!(message.contains(&host.failures()[1].to_string()));
                    assert!(!message.contains(&host.failures()[0].to_string()));
                    let combined = host_result(
                        &host,
                        Err(Error::Failed("fixture operation failure".into())),
                    )
                    .unwrap_err()
                    .to_string();
                    assert!(combined.contains("fixture operation failure"));
                    assert!(combined.contains(&host.failures()[1].to_string()));
                }
            }
            assert!(host.commands().is_empty());
        }
    }
}
