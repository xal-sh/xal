use std::env;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::json;
use xal_host::agent::{self, Agent, AgentEvent, Input, Journal, Options, Outcome};
use xal_host::permissions::Permissions;
use xal_host::*;
use xal_services::config::{Configuration, agent_home};
use xal_services::credentials::{Credential, Credentials, Profile, new_id};
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
        };
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            match arg.as_str() {
                "--help" | "-h" => options.help = true,
                "--" => {
                    options.prompt.extend_from_slice(&args[index + 1..]);
                    break;
                }
                "--format" | "--mode" | "--provider" | "--connection" | "--model"
                | "--output-schema" => {
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
        Ok(options)
    }
}

pub async fn run(args: &[String]) -> Result<u8> {
    let args = Arguments::parse(args)?;
    if args.help {
        print(
            "usage: xal-rust run [--format text|json|jsonl] [--mode normal|plan|yolo|custom] [--provider openai] [--connection name] [--model id] [--output-schema file] [prompt]\n\nRun one prompt without the TUI. When prompt is omitted, read standard input.\nUses existing OpenAI API-key connections. Goals, background jobs, other providers and the TUI remain in later native phases.",
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
    let result = execute(&args, &config, &credentials, &home, &cwd, &redactor).await;
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
) -> Result<u8> {
    if config.has_external_plugins() {
        return Err(Error::Failed("configured external plugins are unavailable in the native development executable; use xal until P07".into()));
    }
    if matches!(
        config.settings.typesafe_ai,
        TypeSafeSettings::Enabled { .. }
    ) {
        return Err(Error::Failed("TypeSafe context behavior is unavailable in the native headless phase; use xal until P03".into()));
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
        let mut prompt = String::new();
        io::stdin().read_to_string(&mut prompt).map_err(failure)?;
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
    let profile = profile(args, &config.settings, credentials)?;
    let key = match credentials
        .credential("openai", &profile.id)
        .map_err(failure)?
    {
        Some(Credential::ApiKey { key }) => key.clone(),
        _ => {
            return Err(Error::Failed(
                "OpenAI API requires an API-key connection; OAuth providers are part of P03".into(),
            ));
        }
    };
    let endpoint =
        env::var("XAL_OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
    let configured_model = if args.provider.is_none() && args.connection.is_none() {
        config.settings.model.clone()
    } else {
        None
    };
    let model = match args.model.clone().or(configured_model) {
        Some(model) if !model.trim().is_empty() => model,
        Some(_) => return Err(Error::Failed("model must not be empty".into())),
        None => {
            let (model, warning) =
                xal_plugin_openai::default_model(&key, &endpoint, home, &profile.id).await?;
            if let Some(warning) = warning {
                diagnostic(&redactor.redact(&warning))?;
            }
            model
        }
    };
    let mode = args
        .mode
        .as_deref()
        .or(config.settings.mode.as_deref())
        .unwrap_or("normal");
    let permissions = Permissions::load(&config.settings, home, cwd, mode)?;
    let read_only = permissions.read_only;
    let guidance = permissions.guidance.clone();
    let cancellation = Cancellation::default();
    let mut host = Host::new(
        vec![
            Box::new(xal_plugin_workspace::Files),
            Box::new(xal_plugin_workspace::Search),
            Box::new(xal_plugin_workspace::Shell),
            Box::new(xal_plugin_openai::OpenAi::new(
                key,
                model.clone(),
                endpoint,
            )?),
        ],
        cancellation.clone(),
    );
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
            provider: "openai".into(), profile: Some(profile.id.clone()), model: model.clone(), mode: mode.into(),
            instructions: crate::prompt::instructions(cwd, mode, read_only, &guidance),
            thinking: thinking(&config.settings, &model),
            context_window: configured_count(&config.settings.context_windows, &model).unwrap_or_else(|| xal_plugin_openai::context_window(&model)),
            compaction_limit: configured_count(&config.settings.compaction_limits, &model), output_schema: schema, artifacts: directory.join(&id),
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
        let control = agent.control();
        let operation = agent.run(Input { text: prompt, images: Vec::new() });
        tokio::pin!(operation);
        let (outcome, exit) = tokio::select! {
            biased;
            signal = termination() => {
                control.interrupt();
                let result = operation.await;
                (result?, Some(signal?))
            }
            result = &mut operation => (result?, None),
        };
        Ok((id, outcome, exit))
    }.await;
    host.shutdown().await;
    let failures = host
        .failures()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    if !failures.is_empty() {
        return Err(Error::Failed(redactor.redact(&failures)));
    }
    let (id, outcome, exit) = result?;
    match args.format {
        Format::Json => {
            let mut value = serde_json::to_value(&outcome).map_err(failure)?;
            value["sessionId"] = json!(id);
            value["provider"] = json!("openai");
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
    Ok(exit.unwrap_or_else(|| outcome.exit_code()))
}

#[cfg(unix)]
async fn termination() -> Result<u8> {
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
async fn termination() -> Result<u8> {
    tokio::signal::ctrl_c().await.map_err(failure)?;
    Ok(130)
}

fn profile(args: &Arguments, settings: &Settings, credentials: &Credentials) -> Result<Profile> {
    let profiles = credentials.profiles();
    let named = args
        .connection
        .as_ref()
        .map(|name| {
            profiles
                .iter()
                .find(|profile| profile.name.to_lowercase() == name.trim().to_lowercase())
                .cloned()
                .ok_or_else(|| Error::Failed(format!("unknown connection: {name}")))
        })
        .transpose()?;
    if let Some(profile) = &named
        && args
            .provider
            .as_ref()
            .is_some_and(|provider| provider != &profile.provider)
    {
        return Err(Error::Failed(format!(
            "connection {} belongs to {}, not {}",
            profile.name,
            profile.provider,
            args.provider.as_deref().unwrap_or("")
        )));
    }
    let configured = profiles
        .iter()
        .find(|profile| Some(&profile.id) == settings.profile.as_ref());
    let provider = args
        .provider
        .as_deref()
        .or_else(|| named.as_ref().map(|profile| profile.provider.as_str()))
        .or_else(|| configured.map(|profile| profile.provider.as_str()))
        .or(settings.provider.as_deref())
        .unwrap_or("openai");
    if provider != "openai" {
        return Err(Error::Failed(format!(
            "provider {provider} is unavailable in the native headless phase; only OpenAI API Responses is implemented"
        )));
    }
    if let Some(profile) = named {
        return Ok(profile);
    }
    if let Some(profile) = configured.filter(|profile| profile.provider == provider) {
        return Ok(profile.clone());
    }
    let available = profiles
        .iter()
        .filter(|profile| profile.provider == provider)
        .cloned()
        .collect::<Vec<_>>();
    match available.as_slice() {
        [profile] => Ok(profile.clone()),
        [] => Err(Error::Failed(
            "OpenAI is not connected; connect an API-key profile with xal first".into(),
        )),
        _ => Err(Error::Failed(
            "OpenAI has multiple connections; select one with --connection".into(),
        )),
    }
}

fn configured_count(
    values: &std::collections::BTreeMap<String, std::collections::BTreeMap<String, f64>>,
    model: &str,
) -> Option<u64> {
    values
        .get("openai")
        .and_then(|models| models.get(model))
        .map(|value| *value as u64)
}

fn thinking(settings: &Settings, model: &str) -> Option<String> {
    settings
        .thinking
        .get("openai")
        .and_then(|models| models.get(model))
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
        .or_else(|| xal_plugin_openai::default_thinking(model).map(str::to_owned))
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
