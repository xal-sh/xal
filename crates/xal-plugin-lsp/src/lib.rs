use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use xal_host::*;
use xal_services::lsp::{Manager, Query, parse_config};
use xal_services::redactor::Redactor;

pub struct Lsp {
    manager: Arc<Manager>,
    cwd: PathBuf,
    redactor: Arc<Redactor>,
}

impl Lsp {
    pub fn new(config: &JsonObject, cwd: PathBuf, redactor: Arc<Redactor>) -> Result<Self> {
        let parsed = parse_config(config, &std::env::vars().collect())
            .map_err(|error| Error::Failed(redactor.redact(&error.to_string())))?;
        redactor.protect(parsed.secrets).map_err(failure)?;
        let manager = Manager::new(
            parsed.servers,
            "xal".into(),
            env!("CARGO_PKG_VERSION").into(),
        )
        .map_err(|error| Error::Failed(redactor.redact(&error.to_string())))?;
        Ok(Self {
            manager: Arc::new(manager),
            cwd,
            redactor,
        })
    }
}

impl Plugin for Lsp {
    fn name(&self) -> &str {
        "lsp"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let available = self.manager.clone();
        let manager = self.manager.clone();
        let redactor = self.redactor.clone();
        registration.tool("lsp", Tool {
            title: Some(Box::new(|args, session| Ok(format!("{} · {}", args.get("operation").and_then(Value::as_str).unwrap_or("query"), session.display_path(args.get("file_path").and_then(Value::as_str).unwrap_or(""))?)))),
            description: "Query a configured language server for semantic code intelligence. Supports definitions, references, hover, document or workspace symbols, implementations, incoming or outgoing calls, and diagnostics. file_path selects the language server and project; line and column are 1-based and required for position-based operations.".into(),
            parameters: serde_json::from_value(json!({"type":"object","properties":{
                "operation":{"type":"string","enum":["definition","references","hover","document_symbols","workspace_symbols","implementation","incoming_calls","outgoing_calls","diagnostics"]},
                "file_path":{"type":"string","minLength":1,"description":"Existing source file, absolute or relative to the working directory"},
                "line":{"type":"integer","minimum":1,"description":"1-based source line for position-based operations"},
                "column":{"type":"integer","minimum":1,"description":"1-based UTF-16 source column for position-based operations"},
                "query":{"type":"string","description":"Symbol query required by workspace_symbols"}
            },"required":["operation","file_path"],"additionalProperties":false})).map_err(failure)?,
            effects: Effects::read,
            concurrency: None,
            permission_subject: None,
            redact: None,
            available: Box::new(move |session| Ok(available.has_available_server(&session.cwd))),
            run: Box::new(move |args, context| {
                let manager = manager.clone();
                let redactor = redactor.clone();
                Box::pin(async move {
                    context.cancellation.check()?;
                    let query: Query = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                    query.validate().map_err(failure)?;
                    tokio::task::spawn_blocking(move || {
                        let result = manager.query(&query, &context.session.cwd, &|| context.cancellation.check().is_err());
                        match result {
                            Ok(output) => { context.cancellation.check()?; Ok(ToolResult { output: redactor.redact(&output) }) }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => Err(Error::Cancelled),
                            Err(error) => Err(Error::Failed(redactor.redact(&error.to_string()))),
                        }
                    }).await.map_err(failure)?
                })
            }),
        })?;
        let manager = self.manager.clone();
        let redactor = self.redactor.clone();
        let cwd = self.cwd.clone();
        registration.command_async(
            "lsp",
            "show or restart language servers",
            move |args, cancellation| {
                let manager = manager.clone();
                let redactor = redactor.clone();
                let cwd = cwd.clone();
                Box::pin(async move {
                    cancellation.check()?;
                    if !args.is_empty() && (args[0] != "restart" || args.len() > 2) {
                        return Err(failure("usage: /lsp [restart [server]]"));
                    }
                    tokio::task::spawn_blocking(move || {
                        cancellation.check()?;
                        if !args.is_empty() {
                            manager
                                .restart(args.get(1).map(String::as_str))
                                .map_err(|error| {
                                    Error::Failed(redactor.redact(&error.to_string()))
                                })?;
                        }
                        cancellation.check()?;
                        Ok(redactor.redact(&manager.status_lines(&cwd).join("\n")))
                    })
                    .await
                    .map_err(failure)?
                })
            },
        )?;
        let redactor = self.redactor.clone();
        registration.ui(
            "lsp",
            Box::new(move |input, _| {
                let output = match input {
                    UiContribution::Tool { name, output } if name == "lsp" => {
                        redactor.redact(&summarize(&output))
                    }
                    _ => String::new(),
                };
                Box::pin(async move { Ok(output) })
            }),
        )
    }

    fn shutdown(&mut self) -> Call<'_, ()> {
        let manager = self.manager.clone();
        let redactor = self.redactor.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                manager
                    .close()
                    .map_err(|error| Error::Failed(redactor.redact(&error.to_string())))
            })
            .await
            .map_err(failure)?
        })
    }
}

fn summarize(output: &str) -> String {
    let line = output.lines().next().unwrap_or("LSP");
    if let Some(found) = line.strip_prefix("Found ") {
        return found.into();
    }
    if let Some(none) = line
        .strip_prefix("No ")
        .and_then(|line| line.strip_suffix(" found"))
    {
        return format!("no {none}");
    }
    if line.starts_with("Hover information") {
        return "hover".into();
    }
    line.into()
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
