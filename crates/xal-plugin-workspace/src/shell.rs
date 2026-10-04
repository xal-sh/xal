use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use xal_host::*;
use xal_services::process::EnvironmentVariable;
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
            description: "Execute managed commands in a persistent shell without interactive rc files. cwd, exported variables and functions persist. Default timeout 120 seconds, maximum 600. On macOS sandbox read prevents writes, workspace permits workspace/temp writes, and both deny network. Read-sandbox calls may run concurrently in isolated shells. Set background:true to return a managed job ID immediately; collect output with job_output and stop it with job_kill. Foreground commands can also be promoted. Background commands ignore timeout.".into(),
            parameters: schema(parameters),
            effects: |args| if sandbox_available() && args.get("sandbox").and_then(Value::as_str) == Some("read") && args.get("background").and_then(Value::as_bool) != Some(true) { Effects::Read } else { Effects::Write },
            concurrency: None, permission_subject: None, redact: None, available: Box::new(|_| Ok(true)),
            run: Box::new(move |args, context| {
                let manager = manager.clone();
                Box::pin(async move {
                    let background = args.get("background").and_then(Value::as_bool) == Some(true);
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
                    let request = ShellRequest { session_id: context.session.id.clone(), sandbox_id: sandbox.unwrap_or("plain").into(), command: command.clone(), cwd: cwd.clone(), persistent_launch: launch(vec![executable.clone(), "-s".into()], &context.session.cwd, sandbox)?, isolated_launch: launch(vec![executable, "-c".into(), command.clone()], &context.session.cwd, sandbox)?, environment };
                    let jobs = &context.session.jobs;
                    let prepared = jobs.prepare_process(&command, background)?;
                    let execution = match manager.execute(request) {
                        Ok(execution) => execution,
                        Err(error) => { let error = failure(error); jobs.launch_failed(prepared, &error)?; return Err(error); }
                    };
                    if !background { execution.set_timeout(Duration::from_secs_f64(seconds).as_millis().try_into().map_err(failure)?); }
                    let job = jobs.start_process(prepared, execution, (!background).then_some(seconds as u32))?;
                    loop {
                        let changed = job.changed.notified();
                        tokio::pin!(changed); changed.as_mut().enable();
                        if job.published()? { context.session.undo.lock().map_err(failure)?.invalidate("background shell changes cannot be captured; full undo is unavailable"); return Ok(ToolResult { output: format!("Background job started: {}", job.id) }); }
                        let output = job.take_output()?;
                        if let Some(sender) = &context.output && !output.is_empty() {
                            let sent = tokio::select! { biased; () = context.cancellation.cancelled() => Err(Error::Cancelled), result = sender.send(output) => result };
                            if let Err(error) = sent { jobs.stop(&job.id).await?; return Err(error); }
                        }
                        if job.done()? { break; }
                        tokio::select! { () = &mut changed => {}, () = context.cancellation.cancelled() => { jobs.stop(&job.id).await?; return Err(Error::Cancelled); } }
                    }
                    let output = String::from_utf16_lossy(&xal_services::process::normalize_process_output(job.output()?.encode_utf16().collect()));
                    let snapshot = job.snapshot()?;
                    let detail = snapshot["status"].as_str().ok_or_else(|| failure("shell status missing"))?;
                    Ok(ToolResult { output: format!("{}{}({}{})", output.trim_end(), if output.trim_end().is_empty() { "" } else { "\n" }, detail, sandbox.map_or_else(String::new, |access| format!(" · {access} sandbox"))) })
                })
            }),
        })?;
        registration.workspace_snapshots("bash", xal_host::undo::Scope::Workspace)
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
