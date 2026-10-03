use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde_json::json;
use xal_host::*;
use xal_providers::{
    Id, catalog,
    client::{Account, Client, endpoint},
    profiles,
};
use xal_services::{
    config::{Configuration, agent_home},
    credentials::{Change, Credential, Credentials},
    redactor::Redactor,
    settings::{Settings, TypeSafeSettings},
};

pub fn handles(command: &str) -> bool {
    [
        "connect",
        "connections",
        "profiles",
        "usage",
        "rename",
        "logout",
        "models",
        "model",
        "thinking",
        "context-window",
        "compaction-limit",
        "typesafe",
    ]
    .contains(&command)
}

pub fn client(
    id: Id,
    account: Account,
    settings: &Settings,
    redactor: Arc<Redactor>,
) -> Result<Client> {
    let mut client = Client::new(id, account, settings, redactor)?;
    let variable = format!(
        "XAL_{}_BASE_URL",
        id.as_str().replace('-', "_").to_uppercase()
    );
    if let Ok(value) = env::var(variable) {
        client.endpoint = endpoint(&value)?;
    }
    Ok(client)
}

pub async fn run(args: &[String]) -> Result<u8> {
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let cwd = env::current_dir().map_err(failure)?;
    let config = Configuration::load(&home, &cwd).map_err(failure)?;
    let credentials = Credentials::load(&home.join("credentials.json")).map_err(failure)?;
    let mut secrets = credentials.secrets();
    secrets.extend(config.redaction_values().map_err(failure)?);
    let redactor = Arc::new(Redactor::new(secrets).map_err(failure)?);
    let cancel = Cancellation::default();
    let operation = execute(args, &home, &cwd, &config, &credentials, &redactor, &cancel);
    tokio::pin!(operation);
    let result = tokio::select! {
        biased;
        signal = crate::headless::termination() => {
            cancel.cancel();
            match operation.await {
                Ok(_) | Err(Error::Cancelled) => return signal,
                Err(error) => Err(error),
            }
        }
        result = &mut operation => result,
    };
    match result {
        Ok(value) => {
            writeln!(io::stdout().lock(), "{}", redactor.redact_json(&value)).map_err(failure)?;
            Ok(0)
        }
        Err(error) => Err(failure(redactor.redact(&error.to_string()))),
    }
}

struct Args {
    position: Vec<String>,
    provider: Option<String>,
    connection: Option<String>,
    name: Option<String>,
    method: Option<String>,
    refresh: bool,
    key_stdin: bool,
}
impl Args {
    fn parse(args: &[String]) -> Result<Self> {
        let mut parsed = Self {
            position: Vec::new(),
            provider: None,
            connection: None,
            name: None,
            method: None,
            refresh: false,
            key_stdin: false,
        };
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--refresh" => parsed.refresh = true,
                "--key-stdin" => parsed.key_stdin = true,
                "--provider" | "--connection" | "--name" | "--method" => {
                    let value = args
                        .next()
                        .filter(|v| !v.is_empty() && !v.starts_with('-'))
                        .ok_or_else(|| failure(format!("{arg} expects a value")))?
                        .clone();
                    match arg.as_str() {
                        "--provider" => parsed.provider = Some(value),
                        "--connection" => parsed.connection = Some(value),
                        "--name" => parsed.name = Some(value),
                        "--method" => parsed.method = Some(value),
                        _ => unreachable!(),
                    }
                }
                _ if arg.starts_with('-') => {
                    return Err(failure(format!("unknown account option: {arg}")));
                }
                _ => parsed.position.push(arg.clone()),
            }
        }
        Ok(parsed)
    }
    fn one(&self) -> Result<&str> {
        match self.position.as_slice() {
            [value] => Ok(value),
            _ => Err(failure("command expects exactly one argument")),
        }
    }
}

async fn execute(
    args: &[String],
    home: &Path,
    cwd: &Path,
    config: &Configuration,
    credentials: &Credentials,
    redactor: &Arc<Redactor>,
    cancel: &Cancellation,
) -> Result<serde_json::Value> {
    let command = &args[0];
    if args[1..] == ["--help"] {
        return Ok(json!(
            "connect PROVIDER [NAME] [--name NAME] [--method api-key|device|browser|paste] [--key-stdin]; connections; profiles rename NAME NEW_NAME (or rename NAME NEW_NAME); logout NAME; models [PROVIDER] [--connection NAME] [--refresh]; model ID [--connection NAME]; thinking EFFORT; context-window TOKENS; compaction-limit TOKENS; typesafe on|off [--connection NAME]; usage. API keys and callbacks are never accepted on the command line."
        ));
    }
    let mut args = Args::parse(&args[1..])?;
    let command = if command == "profiles" {
        if args.position.first().is_none_or(|s| s != "rename") {
            return Err(failure("use profiles rename NAME NEW_NAME"));
        }
        args.position.remove(0);
        "rename"
    } else {
        command.as_str()
    };
    if command == "connect" && args.position.len() == 2 && args.name.is_none() {
        args.name = args.position.pop();
    }
    if command == "models" {
        if args.position.len() > 1 || (!args.position.is_empty() && args.provider.is_some()) {
            return Err(failure("use models [PROVIDER] [--connection NAME]"));
        }
        args.provider = args.provider.or_else(|| args.position.pop());
    }
    cancel.check()?;
    if command == "usage" {
        if !args.position.is_empty() {
            return Err(failure("usage takes no arguments"));
        }
        return recording::read_usage(&home.join("usage"));
    }
    if command == "connections" {
        if !args.position.is_empty() {
            return Err(failure("connections takes no arguments"));
        }
        return Ok(json!(credentials.profiles()));
    }
    if command == "connect" {
        let id = Id::parse(args.one()?)?;
        let name =
            xal_services::credentials::profile_name(args.name.as_deref().unwrap_or(id.as_str()))
                .map_err(failure)?;
        if credentials
            .profiles()
            .iter()
            .any(|p| p.name.to_lowercase() == name.to_lowercase())
        {
            return Err(failure("profile name already exists"));
        }
        let method = args.method.as_deref().unwrap_or(match id {
            Id::ChatGpt => "browser",
            Id::Copilot => "device",
            _ => "api-key",
        });
        let mut connection = client(
            id,
            Account::Fixed(Credential::ApiKey { key: String::new() }),
            &config.settings,
            redactor.clone(),
        )?;
        let credential = match method {
            "api-key" if !matches!(id, Id::ChatGpt | Id::Copilot) => {
                let key = secret("API key", args.key_stdin, cancel)
                    .await?
                    .trim()
                    .to_owned();
                if key.is_empty() {
                    return Err(failure("API key cannot be empty"));
                }
                redactor.protect(vec![key.clone()]).map_err(failure)?;
                let credential = Credential::ApiKey { key };
                connection = client(
                    id,
                    Account::Fixed(credential.clone()),
                    &config.settings,
                    redactor.clone(),
                )?;
                connection.validate_key(cancel).await?;
                credential
            }
            "device" if matches!(id, Id::ChatGpt | Id::Copilot | Id::Xai) => {
                let device = connection.device_start(cancel).await?;
                diagnostic(&format!(
                    "Open {} and enter {}",
                    device
                        .verification_uri_complete
                        .as_ref()
                        .unwrap_or(&device.verification_uri),
                    device.user_code
                ))?;
                connection.device_finish(device, cancel).await?
            }
            "browser" | "paste" if id == Id::ChatGpt => {
                let flow = connection.browser_start()?;
                let listener = if method == "browser" {
                    match tokio::net::TcpListener::bind(("127.0.0.1", 1455)).await {
                        Ok(listener) => Some(listener),
                        Err(error) => {
                            diagnostic(&format!(
                                "Browser callback listener unavailable: {error}; paste the callback instead."
                            ))?;
                            None
                        }
                    }
                } else {
                    None
                };
                diagnostic(&format!("Open this authorization URL:\n{}", flow.url))?;
                if method == "browser" {
                    open_browser(&flow.url, cancel).await?;
                }
                let callback = match listener {
                    Some(listener) => {
                        xal_providers::auth::callback(listener, &flow, cancel).await?
                    }
                    None => {
                        secret("Callback URL or authorization code", args.key_stdin, cancel).await?
                    }
                };
                connection.browser_finish(flow, &callback, cancel).await?
            }
            _ => {
                return Err(failure(
                    "authentication method is not supported by this provider",
                ));
            }
        };
        let profile = profiles::update(
            home,
            Change::Create {
                provider: id.as_str().into(),
                name,
                credential,
            },
            cancel,
        )
        .await?;
        if id == Id::TypeSafe {
            return Ok(json!({"connected":profile,"harnessModelUnchanged":true}));
        }
        let activation = async {
            let connection = client(
                id,
                Account::Profile {
                    home: home.into(),
                    id: profile.id.clone(),
                },
                &config.settings,
                redactor.clone(),
            )?;
            let catalog = connection.catalog(home, &profile.id, true, cancel).await?;
            if let Some(warning) = &catalog.warning {
                diagnostic(&redactor.redact(warning))?;
            }
            let model =
                catalog::default_model(id, &catalog.models, env::var("XAL_MODEL").ok().as_deref())?;
            cancel.check()?;
            Configuration::save(
                home,
                cwd,
                json!({"provider":id,"profile":profile.id,"model":model})
                    .as_object()
                    .cloned()
                    .ok_or_else(|| failure("invalid activation"))?,
            )
            .map_err(failure)?;
            Ok(json!({"connected":profile,"model":model}))
        }
        .await;
        if let Err(error) = activation {
            profiles::update(
                home,
                Change::Delete { id: profile.id },
                &Cancellation::default(),
            )
            .await
            .map_err(|cleanup| {
                failure(format!("{error}; connection rollback failed: {cleanup}"))
            })?;
            return Err(error);
        }
        return activation;
    }
    if command == "rename" || command == "logout" {
        let (name, rename) = match (command, args.position.as_slice()) {
            ("rename", [name, rename]) => (name, Some(rename)),
            ("logout", [name]) => (name, None),
            _ => return Err(failure("use rename NAME NEW_NAME or logout NAME")),
        };
        let profile = profiles::select(&config.settings, credentials, None, Some(name))?;
        let change = match rename {
            Some(name) => Change::Rename {
                id: profile.id.clone(),
                name: name.clone(),
            },
            None => Change::Delete {
                id: profile.id.clone(),
            },
        };
        let result = profiles::update(home, change, cancel).await?;
        if rename.is_none() && config.settings.profile.as_ref() == Some(&profile.id) {
            cancel.check()?;
            Configuration::save(
                home,
                cwd,
                json!({"provider":null,"profile":null,"model":null})
                    .as_object()
                    .cloned()
                    .ok_or_else(|| failure("invalid logout patch"))?,
            )
            .map_err(failure)?;
        }
        return Ok(json!(result));
    }
    if command == "typesafe" {
        let patch = match args.one()? {
            "off" => json!({"typesafeAI":{"enabled":false}}),
            "on" => {
                let mut settings = config.settings.clone();
                settings.profile = match &settings.typesafe_ai {
                    TypeSafeSettings::Enabled { profile } => Some(profile.clone()),
                    TypeSafeSettings::Disabled { profile } => profile.clone(),
                };
                let profile = profiles::select(
                    &settings,
                    credentials,
                    Some("typesafe"),
                    args.connection.as_deref(),
                )?;
                json!({"typesafeAI":{"enabled":true,"profile":profile.id}})
            }
            _ => return Err(failure("typesafe expects on or off")),
        };
        cancel.check()?;
        let saved = Configuration::save(
            home,
            cwd,
            patch
                .as_object()
                .cloned()
                .ok_or_else(|| failure("invalid settings patch"))?,
        )
        .map_err(failure)?;
        return Ok(
            json!({"enabled":matches!(saved.settings.typesafe_ai, TypeSafeSettings::Enabled { .. })}),
        );
    }
    if command == "models" && args.connection.is_none() {
        let selected = args.provider.as_deref().map(Id::parse).transpose()?;
        let mut catalogs = Vec::new();
        let mut notices = Vec::new();
        for profile in credentials.profiles().into_iter().filter(|p| {
            p.provider != "typesafe" && selected.is_none_or(|id| id.as_str() == p.provider)
        }) {
            let id = Id::parse(&profile.provider)?;
            let connection = client(
                id,
                Account::Profile {
                    home: home.into(),
                    id: profile.id.clone(),
                },
                &config.settings,
                redactor.clone(),
            )?;
            match connection.catalog(home, &profile.id, true, cancel).await {
                Ok(catalog) => {
                    catalogs.push(json!({"provider":id,"profile":profile,"catalog":catalog}))
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(error) => {
                    notices.push(json!({"provider":id,"profile":profile,"error":error.to_string()}))
                }
            }
        }
        return Ok(json!({"catalogs":catalogs,"notices":notices}));
    }
    let profile = profiles::select(
        &config.settings,
        credentials,
        args.provider.as_deref(),
        args.connection.as_deref(),
    )?;
    let id = Id::parse(&profile.provider)?;
    let connection = client(
        id,
        Account::Profile {
            home: home.into(),
            id: profile.id.clone(),
        },
        &config.settings,
        redactor.clone(),
    )?;
    let catalog = connection
        .catalog(home, &profile.id, args.refresh, cancel)
        .await?;
    if command == "models" {
        return Ok(json!(catalog));
    }
    if id == Id::TypeSafe {
        return Err(failure("TypeSafe cannot be selected as a harness model"));
    }
    if let Some(warning) = catalog.warning {
        diagnostic(&redactor.redact(&warning))?;
    }
    let selected = if command == "model" {
        args.one()?
    } else {
        config
            .settings
            .model
            .as_deref()
            .ok_or_else(|| failure("select a model first"))?
    };
    let info = catalog::resolve(id, &catalog.models, selected, connection.context_cap)?;
    let patch = match command {
        "model" => json!({"provider":id,"profile":profile.id,"model":info.id}),
        "thinking" => {
            let effort = args.one()?;
            if !info
                .thinking
                .as_ref()
                .is_some_and(|t| t.options.iter().any(|v| v == effort))
            {
                return Err(failure("thinking effort is not supported by this model"));
            }
            json!({"thinking":{id.as_str():{info.id:effort}}})
        }
        "context-window" | "compaction-limit" => {
            let count = args
                .one()?
                .parse::<u64>()
                .map_err(|_| failure("token count must be a positive integer"))?;
            if count == 0 || count > 9_007_199_254_740_991 {
                return Err(failure("invalid token count"));
            }
            if command == "context-window"
                && !catalog::resolve(
                    id,
                    &catalog.models,
                    &catalog::canonical(id, selected),
                    connection.context_cap,
                )?
                .context_windows()
                .contains(&count)
            {
                return Err(failure("context window is not supported by this model"));
            }
            let field = if command == "context-window" {
                "contextWindows"
            } else {
                "compactionLimits"
            };
            json!({field:{id.as_str():{catalog::canonical(id, &info.id):count}}})
        }
        _ => return Err(failure("unknown account command")),
    };
    cancel.check()?;
    Configuration::save(
        home,
        cwd,
        patch
            .as_object()
            .cloned()
            .ok_or_else(|| failure("invalid settings patch"))?,
    )
    .map_err(failure)?;
    Ok(patch)
}

async fn secret(prompt: &str, piped: bool, cancel: &Cancellation) -> Result<String> {
    if piped == io::stdin().is_terminal() {
        return Err(failure(
            "use a terminal for hidden input, or --key-stdin with a pipe",
        ));
    }
    if !piped {
        diagnostic(&format!("{prompt} (hidden):"))?;
    }
    input(
        if piped {
            xal_services::secret::Mode::Line
        } else {
            xal_services::secret::Mode::Hidden
        },
        cancel,
    )
    .await
}

pub(crate) async fn input(
    mode: xal_services::secret::Mode,
    cancel: &Cancellation,
) -> Result<String> {
    cancel.check()?;
    struct Interrupt(Arc<AtomicBool>);
    impl Drop for Interrupt {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let interrupted = Interrupt(Arc::new(AtomicBool::new(false)));
    let flag = &interrupted.0;
    let input_flag = flag.clone();
    let mut operation =
        tokio::task::spawn_blocking(move || xal_services::secret::read(&input_flag, mode));
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => { flag.store(true, Ordering::Release); operation.await.map_err(failure)? }
        result = &mut operation => result.map_err(failure)?,
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::Interrupted => Err(Error::Cancelled),
        result => result.map_err(failure),
    }
}

async fn open_browser(url: &str, cancel: &Cancellation) -> Result<()> {
    let mut command = if cfg!(target_os = "macos") {
        tokio::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = tokio::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        tokio::process::Command::new("xdg-open")
    };
    let spawned = command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return diagnostic(&format!(
                "Could not open a browser automatically ({error}); open the printed URL manually."
            ));
        }
    };
    let result = tokio::select! { biased; () = cancel.cancelled() => None, result = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()) => Some(result) };
    match result {
        Some(Ok(Ok(status))) if status.success() => Ok(()),
        Some(Ok(result)) => diagnostic(&format!(
            "Browser launcher did not succeed ({result:?}); open the printed URL manually."
        )),
        result => {
            child.kill().await.map_err(failure)?;
            if result.is_none() {
                return Err(Error::Cancelled);
            }
            diagnostic("Browser launcher timed out; open the printed URL manually.")
        }
    }
}
fn diagnostic(text: &str) -> Result<()> {
    writeln!(io::stderr().lock(), "{text}").map_err(failure)
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
