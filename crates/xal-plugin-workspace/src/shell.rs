use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use xal_host::*;
use xal_services::process::{EnvironmentVariable, normalize_process_output};
use xal_services::shell::{ShellManager, ShellRequest};

use super::{failure, schema, text};

pub struct Shell;

impl Plugin for Shell {
    fn name(&self) -> &str {
        "shell"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.prompt_source("shell", Box::new(|session| {
            let shell = xal_services::shell::select().map_err(failure)?;
            Ok(format!("Platform: {}. Working directory: {}.\nShell: {}{}, without interactive rc files. OS shell sandbox: {}.", std::env::consts::OS, session.cwd.display(), shell.label, shell.diagnostic.map_or_else(String::new, |message| format!(" ({message})")), if sandbox_available() { "macOS sandbox-exec (read/workspace, network denied)" } else { "unavailable; commands are not OS-sandboxed" }))
        }))?;
        registration.ui(
            "bash",
            Box::new(|contribution, _| {
                Box::pin(async move {
                    let UiContribution::Text { text } = contribution else {
                        return Err(failure("shell title renderer expects text"));
                    };
                    Ok(super::compact_command_title(&text))
                })
            }),
        )?;
        let manager = Arc::new(ShellManager::new());
        let owned = manager.clone();
        registration.session_disposer(Box::new(move |_, context| {
            let manager = owned.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || manager.shutdown_session(&context.session.id))
                    .await
                    .map_err(failure)?
                    .map_err(failure)
            })
        }));
        let owned = manager.clone();
        registration.own_async(move || {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || owned.shutdown_all())
                    .await
                    .map_err(failure)?
                    .map_err(failure)
            })
        });
        let mut parameters = json!({"type":"object","properties":{"command":{"type":"string","minLength":1},"timeout":{"type":"number"},"background":{"type":"boolean"}},"required":["command"],"additionalProperties":false});
        if sandbox_available() {
            parameters["properties"]["sandbox"] =
                json!({"type":"string","enum":["read","workspace"]});
        }
        registration.tool("bash", Tool {
            title: Some(Box::new(|args, _| Ok(args.get("command").and_then(Value::as_str).unwrap_or("").into()))),
            description: "Execute foreground commands in a persistent shell without interactive rc files. cwd, exported variables and functions persist. Default timeout 120 seconds, maximum 600. On macOS sandbox read prevents writes, workspace permits workspace/temp writes, and both deny network. Read-sandbox calls may run concurrently in isolated shells. Background jobs are not available in this native phase.".into(),
            parameters: schema(parameters),
            effects: |args| if sandbox_available() && args.get("sandbox").and_then(Value::as_str) == Some("read") && args.get("background").and_then(Value::as_bool) != Some(true) { Effects::Read } else { Effects::Write },
            concurrency: None, permission_subject: None, redact: None, available: Box::new(|_| Ok(true)),
            run: Box::new(move |args, context| {
                let manager = manager.clone();
                Box::pin(async move {
                    if args.get("background").and_then(Value::as_bool) == Some(true) { return Err(Error::Failed("background jobs are unavailable in the native headless phase".into())); }
                    context.cancellation.check()?;
                    let command = text(&args, "command")?;
                    let sandbox = args.get("sandbox").and_then(Value::as_str);
                    let seconds = args.get("timeout").and_then(Value::as_f64).unwrap_or(120.0).round().clamp(1.0, 600.0);
                    let executable = xal_services::shell::select().map_err(failure)?.executable;
                    let cwd = context.session.cwd.to_string_lossy().into_owned();
                    let mut environment = std::env::vars().map(|(name, value)| EnvironmentVariable { name, value }).collect::<Vec<_>>();
                    environment.retain(|entry| entry.name != "PWD");
                    environment.push(EnvironmentVariable { name: "PWD".into(), value: cwd.clone() });
                    if sandbox.is_some() {
                        let count = environment.iter().find(|entry| entry.name == "GIT_CONFIG_COUNT").and_then(|entry| entry.value.parse::<u32>().ok()).unwrap_or(0);
                        environment.retain(|entry| entry.name != "GIT_CONFIG_COUNT");
                        environment.extend([
                            EnvironmentVariable { name: "GIT_CONFIG_COUNT".into(), value: count.saturating_add(1).to_string() },
                            EnvironmentVariable { name: format!("GIT_CONFIG_KEY_{count}"), value: "core.fsmonitor".into() },
                            EnvironmentVariable { name: format!("GIT_CONFIG_VALUE_{count}"), value: "false".into() },
                        ]);
                    }
                    let request = ShellRequest { session_id: context.session.id.clone(), sandbox_id: sandbox.unwrap_or("plain").into(), command: command.clone(), cwd: cwd.clone(), persistent_launch: launch(vec![executable.clone(), "-s".into()], &context.session.cwd, sandbox)?, isolated_launch: launch(vec![executable, "-c".into(), command], &context.session.cwd, sandbox)?, environment };
                    let execution = manager.execute(request).map_err(failure)?;
                    execution.set_timeout(Duration::from_secs_f64(seconds).as_millis().try_into().map_err(failure)?);
                    let mut wait = execution.wait();
                    let completion = tokio::task::spawn_blocking(move || wait.compute());
                    tokio::pin!(completion);
                    let mut output = Vec::new();
                    let mut delivered = 0;
                    let deadline = tokio::time::sleep(Duration::from_secs_f64(seconds) + Duration::from_secs(1));
                    tokio::pin!(deadline);
                    let mut timed_out = false;
                    let termination = loop {
                        output.extend(execution.drain());
                        if output.len() > 64 * 1024 * 1024 {
                            execution.kill();
                            completion.await.map_err(failure)?.map_err(failure)?;
                            return Err(Error::Failed("shell output exceeded 64 MiB; process killed".into()));
                        }
                        if let Some(sender) = &context.output {
                            let available = match std::str::from_utf8(&output[delivered..]) {
                                Ok(_) => output.len(),
                                Err(error) if error.error_len().is_none() => delivered + error.valid_up_to(),
                                Err(_) => output.len(),
                            };
                            if available > delivered {
                                if let Err(error) = sender.send(String::from_utf8_lossy(&output[delivered..available]).into_owned()).await {
                                    execution.kill();
                                    completion.await.map_err(failure)?.map_err(failure)?;
                                    return Err(error);
                                }
                                delivered = available;
                            }
                        }
                        tokio::select! {
                            biased;
                            () = &mut deadline => {
                                timed_out = true;
                                execution.kill();
                                break completion.await.map_err(failure)?.map_err(failure)?;
                            }
                            () = context.cancellation.cancelled() => {
                                execution.kill();
                                completion.await.map_err(failure)?.map_err(failure)?;
                                return Err(Error::Cancelled);
                            }
                            result = &mut completion => break result.map_err(failure)?.map_err(failure)?,
                            () = tokio::time::sleep(Duration::from_millis(5)) => {},
                        }
                    };
                    output.extend(execution.drain());
                    let output = String::from_utf16_lossy(&normalize_process_output(String::from_utf8_lossy(&output).encode_utf16().collect()));
                    let footer = if timed_out || execution.timed_out() { format!("(timed out after {seconds}s and was killed)") }
                        else if termination.status == "signaled" { "(terminated by signal)".into() }
                        else { format!("(exit code {}{})", termination.exit_code.ok_or_else(|| Error::Failed("shell exit code missing".into()))?, sandbox.map_or_else(String::new, |access| format!(" · {access} sandbox"))) };
                    Ok(ToolResult { output: if output.trim_end().is_empty() { footer } else { format!("{}\n{footer}", output.trim_end()) } })
                })
            }),
        })
    }
}

fn launch(command: Vec<String>, cwd: &Path, sandbox: Option<&str>) -> Result<Vec<String>> {
    let Some(access) = sandbox else {
        return Ok(command);
    };
    if !sandbox_available() {
        return Err(Error::Failed("OS shell sandbox is unavailable".into()));
    }
    let writes = if access == "read" {
        "(deny file-write* (require-not (literal \"/dev/null\")))".into()
    } else {
        let roots = [cwd.to_path_buf(), std::env::temp_dir(), "/tmp".into()]
            .into_iter()
            .map(|path| {
                path.canonicalize()
                    .map(|path| {
                        format!(
                            "(subpath \"{}\")",
                            path.to_string_lossy()
                                .replace('\\', "\\\\")
                                .replace('"', "\\\"")
                        )
                    })
                    .map_err(failure)
            })
            .collect::<Result<Vec<_>>>()?;
        format!(
            "(deny file-write* (require-not (require-any {} (literal \"/dev/null\"))))",
            roots.join(" ")
        )
    };
    Ok([
        vec![
            "/usr/bin/sandbox-exec".into(),
            "-p".into(),
            format!("(version 1)\n(allow default)\n(deny network*)\n{writes}"),
        ],
        command,
    ]
    .concat())
}
