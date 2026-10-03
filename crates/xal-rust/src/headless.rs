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
use xal_services::settings::{Settings, ThinkingEffort, TypeSafeSettings};

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
    compact: bool,
    focus: Option<String>,
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
            compact: false,
            focus: None,
        };
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            match arg.as_str() {
                "--help" | "-h" => options.help = true,
                "--profile" => options.profile = true,
                "--compact" => options.compact = true,
                "--" => {
                    options.prompt.extend_from_slice(&args[index + 1..]);
                    break;
                }
                "--format" | "--mode" | "--provider" | "--connection" | "--model"
                | "--output-schema" | "--continue-from" | "--focus" => {
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
        if options.focus.is_some() && !options.compact {
            return Err(failure("--focus requires --compact"));
        }
        if options.compact && options.continue_from.is_none() {
            return Err(failure("--compact requires --continue-from"));
        }
        Ok(options)
    }
}

pub async fn run(args: &[String]) -> Result<u8> {
    let args = Arguments::parse(args)?;
    if args.help {
        print(
            "usage: xal-rust run [--format text|json|jsonl] [--mode normal|plan|yolo|custom] [--provider id] [--connection name] [--model id] [--output-schema file] [--continue-from journal] [--compact [--focus text]] [--profile] [prompt]\n\nRun one prompt without the TUI. When prompt is omitted, read standard input.\nUses named API-key and OAuth connections. TypeSafe is a decision provider, not a text model. Goals, background jobs and the TUI remain in later native phases.",
        )?;
        return Ok(0);
    }
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let cwd = env::current_dir().map_err(failure)?;
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
        &args,
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
        signal = termination() => {
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

async fn execute(
    args: &Arguments,
    config: &Configuration,
    credentials: &Credentials,
    home: &Path,
    cwd: &Path,
    redactor: &std::sync::Arc<Redactor>,
    cancellation: &Cancellation,
) -> Result<u8> {
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
    let prompt = if !prompt.trim().is_empty() {
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
    if prompt == "/goal" || prompt.starts_with("/goal ") {
        return Err(Error::Failed(
            "headless /goal workflows are unavailable in the native executable until P05".into(),
        ));
    }
    let profile = profiles::select(
        &config.settings,
        credentials,
        args.provider.as_deref(),
        args.connection.as_deref(),
    )?;
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
        config.settings.model.clone()
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
    let thinking = thinking(&config.settings, provider, &info);
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
    let mode = args
        .mode
        .as_deref()
        .or(config.settings.mode.as_deref())
        .unwrap_or("normal");
    let permissions = Permissions::load(&config.settings, home, cwd, mode)?;
    let read_only = permissions.read_only;
    let guidance = permissions.guidance.clone();
    let mut plugins: Vec<Box<dyn Plugin>> = vec![
        Box::new(xal_plugin_workspace::Files),
        Box::new(xal_plugin_workspace::Search),
        Box::new(xal_plugin_workspace::Shell),
        Box::new(xal_plugin_providers::TextProvider { client, models }),
        Box::new(xal_plugin_classify::Classify {
            home: home.into(),
            cwd: cwd.into(),
        }),
    ];
    let decision_profile = match &config.settings.typesafe_ai {
        TypeSafeSettings::Enabled { profile } => Some(profile.clone()),
        TypeSafeSettings::Disabled { profile } => profile.clone(),
    };
    if let Some(profile) = &decision_profile {
        plugins.push(Box::new(xal_plugin_providers::TypeSafe(
            crate::accounts::client(
                Id::TypeSafe,
                Account::Profile {
                    home: home.into(),
                    id: profile.clone(),
                },
                &config.settings,
                redactor.clone(),
            )?,
        )));
    }
    let mut host = Host::new(plugins, cancellation.clone());
    let recorder = recording::Recorder::new(home, args.profile, redactor.clone())?;
    host.recorder = Some(recorder.clone());
    if let Some(profile) = decision_profile {
        host.decision_policy(decisions::Settings {
            home: home.into(),
            cwd: cwd.into(),
            profile,
            redactor: redactor.clone(),
        });
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
        let id = new_id().map_err(failure)?;
        let directory = Paths { home: home.into() }.project_sessions(cwd, redactor).map_err(failure)?;
        let session = host.session(id.clone(), cwd.into(), SessionKind::Headless, read_only)?;
        let options = Options {
            provider: provider.as_str().into(), profile: Some(profile.id.clone()), model: model.clone(), mode: mode.into(),
            instructions: crate::prompt::instructions(cwd, mode, read_only, &guidance),
            thinking,
            context_window: info.context_window.unwrap_or(u64::MAX / 5),
            image_input: info.input_modalities.iter().any(|m| m == "image"), summary_target: Some(summary_target),
            compaction_limit, output_schema: schema, artifacts: directory.join(&id),
        };
        let journal = Journal::create(&directory.join(format!("{id}.jsonl")), &agent::metadata(&session, &options, redactor)?)?;
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
        if let Some(path) = &args.continue_from { agent.restore(&xal_services::records::read_journal(path).map_err(failure)?)?; }
        if args.compact { agent.compact(args.focus.as_deref()).await?; }
        let outcome = agent.run(Input { text: prompt, images: Vec::new() }).await?;
        Ok((id, outcome))
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
    let (id, outcome) = result?;
    match args.format {
        Format::Json => {
            let mut value = serde_json::to_value(&outcome).map_err(failure)?;
            value["sessionId"] = json!(id);
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
            Outcome::Interrupted { .. } => {}
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
