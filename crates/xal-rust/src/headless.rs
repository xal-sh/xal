use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde_json::json;
use xal_host::agent::{self, Agent, AgentEvent, Input, Journal, Options, Outcome};
use xal_host::permissions::Permissions;
use xal_host::*;
use xal_providers::{
    Id,
    catalog::{self, Model},
    client::Account,
    profiles,
};
use xal_services::config::{Configuration, agent_home};
use xal_services::credentials::{Credentials, new_id};
use xal_services::paths::Paths;
use xal_services::redactor::Redactor;
use xal_services::settings::{Settings, ThinkingEffort};

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Text,
    Json,
    Jsonl,
}

struct Arguments {
    format: Format,
    mode: Option<String>,
    provider: Option<String>,
    connection: Option<String>,
    model: Option<String>,
    schema: Option<PathBuf>,
    prompt: Vec<String>,
    help: bool,
    profile: bool,
    continue_from: Option<PathBuf>,
    resume: Option<PathBuf>,
    compact: bool,
    focus: Option<String>,
    continuing: bool,
    retry_pending: bool,
}

impl Arguments {
    fn parse(args: &[String]) -> Result<Self> {
        let mut options = Self {
            format: Format::Text,
            mode: None,
            provider: None,
            connection: None,
            model: None,
            schema: None,
            prompt: Vec::new(),
            help: false,
            profile: false,
            continue_from: None,
            resume: None,
            compact: false,
            focus: None,
            continuing: false,
            retry_pending: false,
        };
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            match arg.as_str() {
                "--help" | "-h" => options.help = true,
                "--profile" => options.profile = true,
                "--compact" => options.compact = true,
                "--continue" => options.continuing = true,
                "--" => {
                    options.prompt.extend_from_slice(&args[index + 1..]);
                    break;
                }
                "--format" | "--mode" | "--provider" | "--connection" | "--model"
                | "--output-schema" | "--continue-from" | "--resume" | "--focus" => {
                    let value = args
                        .get(index + 1)
                        .filter(|value| !value.is_empty() && !value.starts_with("--"))
                        .ok_or_else(|| Error::Failed(format!("{arg} expects a value")))?;
                    match arg.as_str() {
                        "--format" => {
                            options.format = match value.as_str() {
                                "text" => Format::Text,
                                "json" => Format::Json,
                                "jsonl" => Format::Jsonl,
                                _ => {
                                    return Err(Error::Failed(
                                        "--format expects one of: text, json, jsonl".into(),
                                    ));
                                }
                            }
                        }
                        "--mode" => options.mode = Some(value.clone()),
                        "--provider" => options.provider = Some(value.clone()),
                        "--connection" => options.connection = Some(value.clone()),
                        "--model" => options.model = Some(value.clone()),
                        "--output-schema" => options.schema = Some(value.into()),
                        "--continue-from" => options.continue_from = Some(value.into()),
                        "--resume" => options.resume = Some(value.into()),
                        "--focus" => options.focus = Some(value.clone()),
                        _ => unreachable!(),
                    }
                    index += 1;
                }
                _ if arg.starts_with('-') => {
                    return Err(Error::Failed(format!("unknown run option: {arg}")));
                }
                _ => options.prompt.push(arg.clone()),
            }
            index += 1;
        }
        if options.continuing && options.resume.is_none() {
            return Err(failure("--continue requires --resume"));
        }
        if options.focus.is_some() && !options.compact {
            return Err(failure("--focus requires --compact"));
        }
        if options.resume.is_some() && options.continue_from.is_some() {
            return Err(failure(
                "--resume and --continue-from are mutually exclusive",
            ));
        }
        if options.compact && options.continue_from.is_none() && options.resume.is_none() {
            return Err(failure("--compact requires --continue-from or --resume"));
        }
        if options.continuing && !options.prompt.is_empty() {
            return Err(failure("--continue cannot be combined with a prompt"));
        }
        Ok(options)
    }
}

pub async fn run(args: &[String]) -> Result<u8> {
    run_options(Arguments::parse(args)?, None, None).await
}

pub async fn worker(path: &Path, worker: &crate::background::Worker) -> Result<u8> {
    let args = Arguments::parse(&[
        "--resume".into(),
        path.to_string_lossy().into_owned(),
        "--format".into(),
        "jsonl".into(),
        "--continue".into(),
    ])?;
    run_options(args, None, Some(worker)).await
}

pub async fn attached(
    source: (Journal, xal_services::sessions::Loaded),
    retry_pending: bool,
) -> Result<u8> {
    let mut args = Arguments::parse(&[
        "--resume".into(),
        source.0.path().to_string_lossy().into_owned(),
        "--continue".into(),
    ])?;
    args.retry_pending = retry_pending;
    run_options(args, Some(source), None).await
}

async fn run_options(
    args: Arguments,
    supplied: Option<(Journal, xal_services::sessions::Loaded)>,
    worker: Option<&crate::background::Worker>,
) -> Result<u8> {
    if args.help {
        print(
            "usage: xal-rust run [--format text|json|jsonl] [--mode normal|plan|yolo|custom] [--provider id] [--connection name] [--model id] [--output-schema file] [--continue-from journal | --resume journal] [--continue] [--compact [--focus text]] [--profile] [prompt]\n\nRun one prompt without the TUI. When prompt is omitted, read standard input.\nUses named API-key and OAuth connections. TypeSafe is a decision provider, not a text model. Use /goal <condition> for an independently evaluated goal loop. --resume <journal> continues in place; --continue-from <journal> creates a fork. The TUI remains in P06.",
        )?;
        return Ok(0);
    }
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let source = match supplied {
        Some(source) => Some(source),
        None => args
            .resume
            .as_ref()
            .or(args.continue_from.as_ref())
            .map(|path| Journal::resume(&crate::sessions::resolve(&home, &path.to_string_lossy())?))
            .transpose()?,
    };
    if let Some((_, loaded)) = &source {
        if let Some(worker) = worker {
            worker.store.assert_owner(&worker.id).map_err(failure)?;
        }
        let store =
            xal_services::background::Store::new(&home, &loaded.meta.id).map_err(failure)?;
        if let Some(lease) = store.lease().map_err(failure)?
            && worker
                .as_ref()
                .is_none_or(|worker| worker.id != lease.worker_id)
        {
            return Err(failure(
                "session has a background lease; use bg attach to take ownership",
            ));
        }
    }
    let mut cwd = env::current_dir().map_err(failure)?;
    if let Some((_, loaded)) = &source {
        let recorded = PathBuf::from(&loaded.current.cwd);
        if recorded.is_dir() {
            cwd = recorded;
        } else {
            diagnostic("The recorded workspace no longer exists; using the current directory.")?;
        }
    }
    let config = match Configuration::load(&home, &cwd) {
        Ok(config) => config,
        Err(error) => return setup_failure(args.format, &error.to_string()),
    };
    let credentials = match Credentials::load(&home.join("credentials.json")) {
        Ok(credentials) => credentials,
        Err(error) => return setup_failure(args.format, &error.to_string()),
    };
    let mut secrets = credentials.secrets();
    secrets.extend(config.redaction_values().map_err(failure)?);
    let redactor = std::sync::Arc::new(Redactor::new(secrets).map_err(failure)?);
    let cancellation = Cancellation::default();
    let operation = execute(
        Execution {
            args: &args,
            source,
            worker,
        },
        &config,
        &credentials,
        &home,
        &cwd,
        &redactor,
        &cancellation,
    );
    tokio::pin!(operation);
    let result = tokio::select! {
        biased;
        signal = async { if worker.is_some() { crate::background::stop_signal().await.map(|()| 130) } else { termination().await } } => {
            cancellation.cancel();
            match operation.await {
                Ok(_) | Err(Error::Cancelled) => Ok(signal?),
                Err(error) => Err(error),
            }
        }
        result = &mut operation => result,
    };
    match result {
        Ok(code) => Ok(code),
        Err(error) => setup_failure(args.format, &redactor.redact(&error.to_string())),
    }
}

struct Execution<'a> {
    args: &'a Arguments,
    source: Option<(Journal, xal_services::sessions::Loaded)>,
    worker: Option<&'a crate::background::Worker>,
}

async fn execute(
    execution: Execution<'_>,
    config: &Configuration,
    credentials: &Credentials,
    home: &Path,
    cwd: &Path,
    redactor: &std::sync::Arc<Redactor>,
    cancellation: &Cancellation,
) -> Result<u8> {
    let Execution {
        args,
        source,
        worker,
    } = execution;
    if config.has_external_plugins() {
        return Err(Error::Failed("configured external plugins are unavailable in the native development executable; use xal until P07".into()));
    }
    let schema = args
        .schema
        .as_ref()
        .map(|path| -> Result<JsonObject> {
            let raw = xal_services::storage::read_json(path)
                .map_err(failure)?
                .ok_or_else(|| Error::Failed(format!("output schema {:?} does not exist", path)))?;
            xal_services::output_contract::OutputContract::new(raw.to_string()).map_err(
                |error| Error::Failed(format!("invalid output schema {:?}: {error}", path)),
            )?;
            raw.as_object()
                .cloned()
                .ok_or_else(|| Error::Failed("output schema must be an object".into()))
        })
        .transpose()?;
    let prompt = args.prompt.join(" ");
    let prompt = if args.continuing {
        String::new()
    } else if !prompt.trim().is_empty() {
        prompt.trim().to_owned()
    } else {
        if io::stdin().is_terminal() {
            return Err(Error::Failed(
                "usage: xal-rust run [options] [prompt]".into(),
            ));
        }
        let prompt = crate::accounts::input(xal_services::secret::Mode::Text, cancellation).await?;
        if prompt.trim().is_empty() {
            return Err(Error::Failed("prompt from standard input was empty".into()));
        }
        prompt.trim().to_owned()
    };
    let recorded_data = source.as_ref().map(|(_, loaded)| loaded.current.clone());
    let recorded = recorded_data.as_ref();
    let profile = if args.provider.is_none() && args.connection.is_none() {
        match recorded {
            Some(meta) => {
                let id = meta.profile.as_ref().ok_or_else(|| {
                    failure("session has no account binding; select --connection explicitly")
                })?;
                credentials.profiles().into_iter().find(|p| &p.id == id && p.provider == meta.provider).ok_or_else(|| failure("the session's original connection is unavailable; select --connection explicitly"))?
            }
            None => profiles::select(&config.settings, credentials, None, None)?,
        }
    } else {
        profiles::select(
            &config.settings,
            credentials,
            args.provider.as_deref(),
            args.connection.as_deref(),
        )?
    };
    let provider = Id::parse(&profile.provider)?;
    if provider == Id::TypeSafe {
        return Err(failure(
            "TypeSafe is a decision provider, not a harness model",
        ));
    }
    let client = crate::accounts::client(
        provider,
        Account::Profile {
            home: home.into(),
            id: profile.id.clone(),
        },
        &config.settings,
        redactor.clone(),
    )?;
    let configured_model = if args.provider.is_none() && args.connection.is_none() {
        recorded
            .map(|meta| meta.model.clone())
            .or_else(|| config.settings.model.clone())
    } else {
        None
    };
    let selected = args.model.clone().or(configured_model);
    let mut models = if selected.is_some() && provider != Id::Copilot {
        let catalog = client.local_catalog(home, &profile.id)?;
        if let Some(warning) = catalog.warning {
            diagnostic(&redactor.redact(&warning))?;
        }
        catalog.models
    } else {
        let catalog = client
            .catalog(home, &profile.id, false, cancellation)
            .await?;
        if let Some(warning) = catalog.warning {
            diagnostic(&redactor.redact(&warning))?;
        }
        catalog.models
    };
    let model = match selected {
        Some(model) => model,
        None => catalog::default_model(provider, &models, env::var("XAL_MODEL").ok().as_deref())?,
    };
    if model.trim().is_empty() {
        return Err(failure("model must not be empty"));
    }
    let info = catalog::configured(
        provider,
        &models,
        &model,
        client.context_cap,
        &config.settings,
    )?;
    let thinking = recorded
        .and_then(|meta| meta.thinking.clone())
        .filter(|effort| {
            info.thinking
                .as_ref()
                .is_some_and(|t| t.options.contains(effort))
        })
        .or_else(|| thinking(&config.settings, provider, &info));
    let compaction_limit = info.auto_compact_token_limit;
    if !models.iter().any(|m| m.id == model) {
        models.push(info.clone());
    }
    let summary_info =
        if provider == Id::ChatGpt && info.supports_fast == Some(true) && !model.ends_with("-fast")
        {
            catalog::configured(
                provider,
                &models,
                &format!("{model}-fast"),
                client.context_cap,
                &config.settings,
            )?
        } else {
            info.clone()
        };
    if !models.iter().any(|m| m.id == summary_info.id) {
        models.push(summary_info.clone());
    }
    let summary_target = agent::SummaryTarget {
        model: summary_info.id.clone(),
        thinking: summary_info.thinking.as_ref().map(|t| {
            if t.options.iter().any(|o| o == "low") {
                "low".into()
            } else {
                t.default.clone()
            }
        }),
        image_input: summary_info.input_modalities.iter().any(|m| m == "image"),
        context_window: summary_info.context_window.unwrap_or(u64::MAX / 5),
    };
    let goal_requested = prompt
        .strip_prefix("/goal")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
    let restored_goal = source
        .as_ref()
        .and_then(|(_, loaded)| {
            loaded
                .events
                .iter()
                .rev()
                .find(|e| e["type"] == "goal_updated")
        })
        .map(|event| xal_services::workflows::Goal::parse(&event["goal"]).map_err(failure))
        .transpose()?;
    let evaluator_model = if goal_requested
        || restored_goal.as_ref().is_some_and(|goal| {
            matches!(
                goal.status,
                xal_services::workflows::GoalStatus::Active
                    | xal_services::workflows::GoalStatus::Suspended { .. }
            )
        }) {
        config
            .settings
            .evaluator_models
            .get(provider.as_str())
            .unwrap_or(&model)
    } else {
        &model
    };
    let offered = |models: &[catalog::Model]| {
        let canonical = catalog::canonical(provider, evaluator_model);
        models.iter().any(|m| {
            m.id == canonical
                || (provider == Id::ChatGpt
                    && canonical.strip_suffix("-fast") == Some(m.id.as_str())
                    && m.supports_fast == Some(true))
        })
    };
    if evaluator_model != &model && !offered(&models) {
        let discovered = client
            .catalog(home, &profile.id, false, cancellation)
            .await?;
        if let Some(warning) = discovered.warning {
            diagnostic(&redactor.redact(&warning))?;
        }
        for candidate in discovered.models {
            if !models.iter().any(|m| m.id == candidate.id) {
                models.push(candidate);
            }
        }
        if !offered(&models) {
            return Err(failure(format!(
                "configured goal evaluator {evaluator_model} is not offered by the selected account"
            )));
        }
    }
    let evaluator_info = catalog::configured(
        provider,
        &models,
        evaluator_model,
        client.context_cap,
        &config.settings,
    )?;
    if !models.iter().any(|m| m.id == *evaluator_model) {
        models.push(evaluator_info.clone());
    }
    let evaluator = agent::SummaryTarget {
        model: evaluator_model.clone(),
        thinking: evaluator_info.thinking.as_ref().and_then(|t| {
            ["none", "low", "medium", "high", "xhigh", "max"]
                .into_iter()
                .find(|effort| t.options.iter().any(|o| o == effort))
                .map(str::to_owned)
        }),
        image_input: evaluator_info.input_modalities.iter().any(|m| m == "image"),
        context_window: evaluator_info.context_window.unwrap_or(u64::MAX / 5),
    };
    let mode = args
        .mode
        .as_deref()
        .or(recorded.map(|meta| meta.mode.as_str()))
        .or(config.settings.mode.as_deref())
        .unwrap_or("normal");
    let permissions = Permissions::load(&config.settings, home, cwd, mode)?;
    let read_only = permissions.read_only;
    let guidance = permissions.guidance.clone();
    crate::integrations::discovery(config, redactor)?;
    let mut plugins = crate::integrations::plugins(config, home, cwd, redactor)?;
    plugins.push(Box::new(xal_plugin_providers::TextProvider {
        client,
        models,
    }));
    let decision_policy =
        crate::integrations::decision_plugins(config, home, cwd, redactor, &mut plugins)?;
    let mut host = Host::new(plugins, cancellation.clone());
    host.task_service = Some(crate::task_agents::service(config, home, redactor));
    let recorder = recording::Recorder::new(home, args.profile, redactor.clone())?;
    host.recorder = Some(recorder.clone());
    if let Some(policy) = decision_policy {
        host.decision_policy(policy);
    }
    host.permissions(permissions);
    host.output_policy(
        redactor.clone(),
        Paths { home: home.into() }
            .project_sessions(cwd, redactor)
            .map_err(failure)?,
    );
    let result = async {
        host.start().await?;
        for warning in host.warnings() {
            diagnostic(&redactor.redact(warning))?;
        }
        let id = if args.resume.is_some() { source.as_ref().ok_or_else(|| failure("resume source missing"))?.1.meta.id.clone() } else { new_id().map_err(failure)? };
        let directory = Paths { home: home.into() }.project_sessions(cwd, redactor).map_err(failure)?;
        let session = host.session(id.clone(), cwd.into(), if worker.is_some() { SessionKind::Interactive } else { SessionKind::Headless }, read_only)?;
        let options = Options {
            provider: provider.as_str().into(), profile: Some(profile.id.clone()), model: model.clone(), mode: mode.into(),
            instructions: crate::prompt::instructions(mode, read_only, &guidance),
            thinking,
            context_window: info.context_window.unwrap_or(u64::MAX / 5),
            image_input: info.input_modalities.iter().any(|m| m == "image"), summary_target: Some(summary_target),
            compaction_limit, output_schema: schema, artifacts: directory.join(&id),
        };
        let (journal, loaded) = match source {
            Some((journal, loaded)) if args.resume.is_some() => (journal, Some(loaded)),
            Some((source, loaded)) => (source.fork(&directory.join(format!("{id}.jsonl")), &id, agent::now()?)?, Some(loaded)),
            None => (Journal::create(&directory.join(format!("{id}.jsonl")), &agent::metadata(&session, &options, redactor)?)?, None),
        };
        let mut receive = |event: AgentEvent| -> Result<()> {
            if args.format == Format::Jsonl { return print(&serde_json::to_string(&event).map_err(failure)?); }
            match event {
                AgentEvent::ApprovalRequested { .. } => diagnostic("This action needed approval but the session is headless, so it was not run. Rerun with --mode yolo to allow it."),
                AgentEvent::RetryScheduled { attempt, max_attempts, delay_ms, message } => diagnostic(&format!("[retrying in {}s · attempt {attempt}/{max_attempts}] {message}", delay_ms.div_ceil(1000))),
                AgentEvent::Error { message } => diagnostic(&message),
                _ => Ok(()),
            }
        };
        let mut agent = Agent::new(&host, session, options, redactor, Some(journal), &mut receive)?;
        if let Some(loaded) = &loaded { agent.restore_existing(loaded)?; }
        let modes = ["normal", "plan", "yolo"].into_iter().map(str::to_owned).chain(config.settings.modes.keys().cloned()).map(|mode| {
            let policy = Permissions::load(&config.settings, home, cwd, &mode)?;
            let instructions = crate::prompt::instructions(&mode, policy.read_only, &policy.guidance);
            Ok((policy, instructions))
        }).collect::<Result<Vec<_>>>()?;
        agent.configure_modes(modes);
        agent.evaluator(evaluator);
        agent.prompt_history(&Paths { home: home.into() }.message_history(&cwd.to_string_lossy()))?;
        agent.reconcile()?;
        if args.compact { agent.compact(args.focus.as_deref()).await?; }
        let outcome = if let Some(worker) = worker { worker.drive(&mut agent).await? } else if args.continuing { let outcome = agent.continue_turn(args.retry_pending).await?; agent.close().await?; outcome } else if let Some(condition) = prompt.strip_prefix("/goal").filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace)) {
            let condition = condition.trim();
            if condition.is_empty() || ["clear", "stop", "off", "reset", "none", "cancel"].contains(&condition) {
                if !condition.is_empty() { agent.clear_goal()?; }
                let response = serde_json::to_value(agent.goal()).map_err(failure)?;
                agent.close().await?;
                Outcome::Completed { response, usage: None, context: None }
            } else {
                agent.start_goal(condition)?;
                agent.run(Input { text: format!("Work toward this goal: {condition}"), images: Vec::new() }).await?
            }
        } else { agent.run(Input { text: prompt, images: Vec::new() }).await? };
        Ok((id, outcome, agent.goal().cloned()))
    }.await;
    host.shutdown().await;
    recorder.flush()?;
    let failures = host
        .failures()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    if !failures.is_empty() {
        return Err(Error::Failed(redactor.redact(&failures)));
    }
    let (id, outcome, goal) = result?;
    match args.format {
        Format::Json => {
            let mut value = serde_json::to_value(&outcome).map_err(failure)?;
            value["sessionId"] = json!(id);
            if let Some(goal) = &goal {
                value["goal"] = json!(goal);
            }
            value["provider"] = json!(provider);
            value["model"] = json!(redactor.redact(&model));
            print(&value.to_string())?;
        }
        Format::Jsonl => {}
        Format::Text => match &outcome {
            Outcome::Completed { response, .. } => print(&match response.as_str() {
                Some(text) => text.into(),
                None => serde_json::to_string_pretty(response).map_err(failure)?,
            })?,
            Outcome::Failed { error, .. } => diagnostic(error)?,
            Outcome::Interrupted { .. } | Outcome::Paused { .. } | Outcome::NeedsInput { .. } => {}
        },
    }
    Ok(outcome.exit_code())
}

#[cfg(unix)]
pub(crate) async fn termination() -> Result<u8> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt()).map_err(failure)?;
    let mut terminate = signal(SignalKind::terminate()).map_err(failure)?;
    let mut hangup = signal(SignalKind::hangup()).map_err(failure)?;
    let (received, code) = tokio::select! {
        received = interrupt.recv() => (received, 130),
        received = terminate.recv() => (received, 143),
        received = hangup.recv() => (received, 129),
    };
    received.ok_or_else(|| Error::Failed("signal listener closed".into()))?;
    Ok(code)
}

#[cfg(not(unix))]
pub(crate) async fn termination() -> Result<u8> {
    tokio::signal::ctrl_c().await.map_err(failure)?;
    Ok(130)
}

fn thinking(settings: &Settings, provider: Id, model: &Model) -> Option<String> {
    settings
        .thinking
        .get(provider.as_str())
        .and_then(|models| models.get(&model.id))
        .map(|effort| {
            match effort {
                ThinkingEffort::None => "none",
                ThinkingEffort::Low => "low",
                ThinkingEffort::Medium => "medium",
                ThinkingEffort::High => "high",
                ThinkingEffort::XHigh => "xhigh",
                ThinkingEffort::Max => "max",
            }
            .into()
        })
        .filter(|effort| {
            model
                .thinking
                .as_ref()
                .is_some_and(|t| t.options.contains(effort))
        })
        .or_else(|| model.thinking.as_ref().map(|t| t.default.clone()))
}

fn setup_failure(format: Format, message: &str) -> Result<u8> {
    match format {
        Format::Text => diagnostic(message)?,
        Format::Json => print(&json!({"status":"failed","error":message}).to_string())?,
        Format::Jsonl => print(&json!({"type":"error","message":message}).to_string())?,
    }
    Ok(1)
}

fn print(text: &str) -> Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "{text}").map_err(failure)?;
    output.flush().map_err(failure)
}
fn diagnostic(text: &str) -> Result<()> {
    writeln!(io::stderr().lock(), "{text}").map_err(failure)
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
