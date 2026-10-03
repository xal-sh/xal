use std::env;
use std::io;

use xal_host::{
    Effects, Error, JsonObject, Plugin, PolicyDecision, Registration, Result, Tool, ToolResult,
};
use xal_services::config::{Configuration, agent_home};
use xal_services::credentials::Credentials;
use xal_services::paths::Paths;
use xal_services::records::read_journal;
use xal_services::redactor::Redactor;

pub struct Inspect;

impl Plugin for Inspect {
    fn name(&self) -> &str {
        "inspect"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.command(
            "config-check",
            "Validate settings, trust, credentials and paths without writes",
            |args, cancellation| {
                if !args.is_empty() {
                    return Err(Error::Failed("config-check takes no arguments".into()));
                }
                cancellation.check()?;
                check_configuration().map_err(failure)
            },
        )?;
        registration.command(
            "storage-check",
            "Read a session JSONL envelope without rewriting or replaying it",
            |args, cancellation| {
                let [path] = args else {
                    return Err(Error::Failed("usage: storage-check <session.jsonl>".into()));
                };
                cancellation.check()?;
                let records = read_journal(std::path::Path::new(path)).map_err(failure)?;
                for record in &records {
                    let encoded = record.encode().map_err(failure)?;
                    if xal_services::records::Record::parse(&encoded).map_err(failure)? != *record {
                        return Err(Error::Failed("session codec round-trip mismatch".into()));
                    }
                }
                Ok(format!(
                    "Session envelopes: {} (read-only; no replay or recovery performed)\n",
                    records.len()
                ))
            },
        )?;
        registration.tool(
            "config-inspect",
            Tool {
                description: "Read configuration foundations without exposing credentials".into(),
                parameters: JsonObject::new(),
                effects: Effects::read,
                redact: None,
                available: Box::new(|_| Ok(true)),
                run: Box::new(|args, context| {
                    Box::pin(async move {
                        context.cancellation.check()?;
                        if !args.is_empty() {
                            return Err(Error::Failed("config-inspect takes no arguments".into()));
                        }
                        Ok(ToolResult {
                            output: check_configuration().map_err(failure)?,
                        })
                    })
                }),
            },
        )?;
        registration.policy(
            "inspect-read-only",
            Box::new(|request, _| {
                Box::pin(async move {
                    Ok(if request.tool == "config-inspect" && request.read_only {
                        PolicyDecision::Allow
                    } else {
                        PolicyDecision::Abstain
                    })
                })
            }),
        )
    }
}

fn failure(error: io::Error) -> Error {
    Error::Failed(error.to_string())
}

fn check_configuration() -> io::Result<String> {
    let override_home = env::var("XAL_HOME")
        .map(Some)
        .or_else(|error| match error {
            env::VarError::NotPresent => Ok(None),
            env::VarError::NotUnicode(_) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "XAL_HOME is not valid Unicode",
            )),
        })?;
    let paths = Paths {
        home: agent_home(override_home.as_deref(), env::home_dir())?,
    };
    let credentials = Credentials::load(&paths.credentials()).map_err(|error| {
        io::Error::new(
            error.kind(),
            "credentials are malformed or inaccessible; fix credentials.json",
        )
    })?;
    let config = Configuration::load(&paths.home, &env::current_dir()?).map_err(|error| {
        io::Error::new(
            error.kind(),
            "configuration is malformed or inaccessible; check config.json and trust.json",
        )
    })?;
    let redactor = Redactor::new(
        config
            .redaction_values()?
            .into_iter()
            .chain(credentials.secrets())
            .collect(),
    )
    .map_err(io::Error::other)?;
    if config.has_external_plugins() {
        return Err(io::Error::other(
            "external plugins are not supported by the Rust foundation yet; use the legacy xal executable (the new SDK belongs to P07)",
        ));
    }
    let report = format!(
        "Configuration layers loaded (read-only)\nProject: {}\nProject configuration: {}\nValidated settings: all core settings\nCredential profiles: {}\nSession directory: {}\nMessage history: {}\n",
        config.project_root.display(),
        if config.trusted {
            "trusted"
        } else {
            "ignored (untrusted)"
        },
        credentials.profiles().len(),
        paths
            .project_sessions(&config.project_root, &redactor)?
            .display(),
        paths
            .message_history(
                config
                    .project_root
                    .to_str()
                    .ok_or_else(|| io::Error::other("project path is not valid Unicode"))?
            )
            .display(),
    );
    let mut stream = redactor.stream();
    let mut output = String::new();
    for character in report.chars() {
        output.push_str(&stream.write(&character.to_string()));
    }
    output.push_str(&stream.end());
    Ok(output)
}
