use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::sync::Arc;

use xal_host::*;
use xal_services::config::{Configuration, agent_home};
use xal_services::credentials::Credentials;
use xal_services::redactor::Redactor;

pub fn plugins(
    config: &Configuration,
    home: &Path,
    cwd: &Path,
    redactor: &Arc<Redactor>,
) -> Result<Vec<Box<dyn Plugin>>> {
    if config.has_external_plugins() {
        return Err(failure(
            "configured external plugins are unavailable in the native development executable; use xal until P07",
        ));
    }
    let user_home = env::home_dir().ok_or_else(|| failure("cannot determine user home"))?;
    Ok(vec![
        Box::new(xal_host::jobs::Tools),
        Box::new(xal_host::tasks::Tools),
        Box::new(xal_host::workflows::Workflows {
            home: home.into(),
            redactor: redactor.clone(),
        }),
        Box::new(xal_plugin_workspace::Files),
        Box::new(xal_plugin_workspace::Search),
        Box::new(xal_plugin_workspace::Shell),
        Box::new(xal_plugin_workspace::Web),
        Box::new(xal_plugin_workspace::Worktrees::new(
            user_home.clone(),
            home.join("worktrees"),
        )),
        Box::new(xal_plugin_context::Instructions::new(
            home.into(),
            cwd.into(),
        )),
        Box::new(xal_plugin_context::CodeReview::new(cwd.into())),
        Box::new(xal_plugin_context::PromptCommands::new(
            home.into(),
            cwd.into(),
        )),
        Box::new(xal_plugin_context::Skills::new(
            home.into(),
            user_home,
            cwd.into(),
        )),
        Box::new(xal_plugin_context::Memory::new(
            home.join("MEMORY.md"),
            redactor.clone(),
        )),
        Box::new(lsp(config, cwd, redactor)?),
        Box::new(xal_plugin_mcp::Mcp::new(
            config,
            home.into(),
            cwd.into(),
            redactor.clone(),
        )?),
    ])
}

fn lsp(
    config: &Configuration,
    cwd: &Path,
    redactor: &Arc<Redactor>,
) -> Result<xal_plugin_lsp::Lsp> {
    xal_plugin_lsp::Lsp::new(
        config
            .settings
            .plugin_config
            .get("lsp")
            .unwrap_or(&JsonObject::new()),
        cwd.into(),
        redactor.clone(),
    )
}

pub fn discovery(config: &Configuration, redactor: &Redactor) -> Result<()> {
    for notice in xal_plugin_mcp::project::discover(config, false)
        .map_err(failure)?
        .notices
    {
        writeln!(io::stderr().lock(), "{}", redactor.redact(&notice)).map_err(failure)?;
    }
    Ok(())
}

pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "mcp" | "lsp" | "commands" | "prompt" | "review" | "workspace-paths"
    )
}

pub async fn run(args: &[String]) -> Result<(String, u8)> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(("usage: xal-rust mcp [discover | import project|global --confirm | reconnect [server] | delete server --confirm]\n       xal-rust lsp [restart [server]]\n       xal-rust commands\n       xal-rust prompt <command> [args]\n       xal-rust review [base]\n       xal-rust workspace-paths [query]\n\nPrompt and review print prepared instructions; use run '/command args' to send them to a model. Project MCP imports require a trusted project and an interactive terminal. Language servers are user-installed; no implicit downloads.\n".into(), 0));
    }
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let cwd = env::current_dir().map_err(failure)?;
    let config = Configuration::load(&home, &cwd).map_err(failure)?;
    let mut values = Credentials::load(&home.join("credentials.json"))
        .map_err(failure)?
        .secrets();
    values.extend(config.redaction_values().map_err(failure)?);
    let redactor = Arc::new(Redactor::new(values).map_err(failure)?);
    let cancellation = Cancellation::default();
    let operation = execute(args, config, &home, &cwd, &redactor, &cancellation);
    tokio::pin!(operation);
    let mut exit_code = 130;
    let result = tokio::select! {
        biased;
        signal = crate::headless::termination() => {
            cancellation.cancel();
            match (signal, operation.await) {
                (Ok(code), Ok(_) | Err(Error::Cancelled)) => {
                    exit_code = code;
                    Err(Error::Cancelled)
                }
                (Ok(_), Err(error)) => Err(error),
                (Err(signal), Ok(_) | Err(Error::Cancelled)) => Err(signal),
                (Err(signal), Err(error)) => Err(failure(format!("{signal}\n{error}"))),
            }
        }
        result = &mut operation => result,
    };
    match result {
        Ok(output) => Ok((format!("{}\n", redactor.redact(&output)), 0)),
        Err(Error::Cancelled) => {
            writeln!(io::stderr().lock(), "xal-rust: {}", Error::Cancelled).map_err(failure)?;
            Ok((String::new(), exit_code))
        }
        Err(error) => Err(failure(redactor.redact(&error.to_string()))),
    }
}

async fn execute(
    args: &[String],
    config: Configuration,
    home: &Path,
    cwd: &Path,
    redactor: &Arc<Redactor>,
    cancellation: &Cancellation,
) -> Result<String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(failure("integration command required"));
    };
    if command == "mcp" && args.get(1).is_some_and(|arg| arg == "discover") {
        if args.len() != 2 {
            return Err(failure("usage: xal-rust mcp discover"));
        }
        let discovery = xal_plugin_mcp::project::discover(&config, false).map_err(failure)?;
        return Ok(if discovery.notices.is_empty() {
            "No unapproved MCP servers in a trusted project.".into()
        } else {
            discovery.notices.join("\n")
        });
    }
    if command == "mcp" && args.get(1).is_some_and(|arg| arg == "import") {
        if args.len() != 4 || args[3] != "--confirm" {
            return Err(failure(
                "usage: xal-rust mcp import project|global --confirm",
            ));
        }
        let choice = match args[2].as_str() {
            "project" => xal_plugin_mcp::project::Choice::Project,
            "global" => xal_plugin_mcp::project::Choice::Global,
            _ => return Err(failure("MCP import destination must be project or global")),
        };
        cancellation.check()?;
        xal_plugin_mcp::project::approve(
            config,
            home,
            cwd,
            io::stdin().is_terminal() && io::stdout().is_terminal(),
            choice,
        )
        .map_err(failure)?;
        return Ok(format!(
            "Imported approved MCP servers into {} configuration.",
            args[2]
        ));
    }
    if command == "workspace-paths" {
        return paths(cwd, &args[1..].join(" "), redactor, cancellation).await;
    }
    let plugins: Vec<Box<dyn Plugin>> = match command {
        "mcp" => {
            discovery(&config, redactor)?;
            vec![Box::new(xal_plugin_mcp::Mcp::new(
                &config,
                home.into(),
                cwd.into(),
                redactor.clone(),
            )?)]
        }
        "lsp" => vec![Box::new(lsp(&config, cwd, redactor)?)],
        "review" => vec![Box::new(xal_plugin_context::CodeReview::new(cwd.into()))],
        "commands" | "prompt" => vec![
            Box::new(xal_plugin_context::CodeReview::new(cwd.into())),
            Box::new(xal_plugin_context::PromptCommands::new(
                home.into(),
                cwd.into(),
            )),
        ],
        _ => return Err(failure("unknown integration command")),
    };
    let mut host = Host::new(plugins, cancellation.clone());
    let result = async {
        host.start().await?;
        for warning in host.warnings() {
            writeln!(io::stderr().lock(), "{}", redactor.redact(warning)).map_err(failure)?;
        }
        if command == "commands" {
            if args.len() != 1 {
                return Err(failure("usage: xal-rust commands"));
            }
            return Ok(host
                .commands()
                .iter()
                .map(|(name, description)| format!("/{name} · {description}"))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        if command == "prompt" {
            let name = args
                .get(1)
                .ok_or_else(|| failure("usage: xal-rust prompt <command> [args]"))?;
            return host.execute(name.trim_start_matches('/'), &args[2..]).await;
        }
        host.execute(command, &args[1..]).await
    }
    .await;
    host.shutdown().await;
    crate::host_result(&host, result)
}

async fn paths(
    cwd: &Path,
    query: &str,
    redactor: &Arc<Redactor>,
    cancellation: &Cancellation,
) -> Result<String> {
    let cwd = cwd.to_string_lossy().into_owned();
    let query = query.to_owned();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = cancelled.clone();
    let redactor = redactor.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        let mut index = xal_services::fuzzy::create_workspace_index(
            cwd,
            Vec::new(),
            "[REDACTED]".into(),
            flag.clone(),
        )
        .compute()
        .map_err(failure)?;
        index.retain(|path| redactor.redact(path) == path);
        let result = index.search(query, flag).compute().map_err(failure)?;
        if result.kind == xal_services::tool_contracts::ToolOutcomeKind::Interrupted {
            return Err(Error::Cancelled);
        }
        Ok(result.paths.join("\n"))
    });
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
            task.await.map_err(failure)??;
            Err(Error::Cancelled)
        }
        result = &mut task => result.map_err(failure)?,
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

pub fn decision_plugins(
    config: &Configuration,
    home: &Path,
    cwd: &Path,
    redactor: &Arc<Redactor>,
    plugins: &mut Vec<Box<dyn Plugin>>,
) -> Result<Option<decisions::Settings>> {
    plugins.push(Box::new(xal_plugin_classify::Classify {
        home: home.into(),
        cwd: cwd.into(),
    }));
    let profile = match &config.settings.typesafe_ai {
        xal_services::settings::TypeSafeSettings::Enabled { profile } => Some(profile.clone()),
        xal_services::settings::TypeSafeSettings::Disabled { profile } => profile.clone(),
    };
    let Some(profile) = profile else {
        return Ok(None);
    };
    plugins.push(Box::new(xal_plugin_providers::TypeSafe(
        crate::accounts::client(
            xal_providers::Id::TypeSafe,
            xal_providers::client::Account::Profile {
                home: home.into(),
                id: profile.clone(),
            },
            &config.settings,
            redactor.clone(),
        )?,
    )));
    Ok(Some(decisions::Settings {
        home: home.into(),
        cwd: cwd.into(),
        profile,
        redactor: redactor.clone(),
    }))
}
