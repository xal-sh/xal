use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use xal_host::*;
use xal_services::{
    memory::{Protection, Store},
    redactor::Redactor,
};

use crate::{blocking, failure};

pub struct Memory {
    store: Arc<Store>,
    redactor: Arc<Redactor>,
}

impl Memory {
    pub fn new(path: PathBuf, redactor: Arc<Redactor>) -> Self {
        Self {
            store: Arc::new(Store::new(path)),
            redactor,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Input {
    Read,
    Replace { revision: String, content: String },
    Clear { revision: String },
}

fn redact(args: &JsonObject, redactor: &Redactor) -> Result<JsonObject> {
    let value = Value::Object(args.clone());
    if redactor.redact_json(&value) != value {
        return Err(Error::Denied(
            "global memory request contains a configured secret and cannot be used".into(),
        ));
    }
    Ok(args.clone())
}

impl Plugin for Memory {
    fn name(&self) -> &str {
        "memory"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let redactor = self.redactor.clone();
        registration.ui(
            "memory",
            Box::new(move |contribution, _| {
                let redactor = redactor.clone();
                Box::pin(async move {
                    let UiContribution::Tool { name, output } = contribution else {
                        return Err(failure("memory renderer expects a tool result"));
                    };
                    if name != "memory" {
                        return Err(failure("memory renderer received another tool's result"));
                    }
                    Ok(redactor.redact(&output))
                })
            }),
        )?;
        let store = self.store.clone();
        let redactor = self.redactor.clone();
        registration.prompt_source("global_memory", Box::new(move |session| {
            if session.kind == SessionKind::Task { return Ok(String::new()); }
            let content = store.prompt_content(Protection::Redactor(&redactor)).map_err(failure)?;
            if content.is_empty() { return Ok(content); }
            Ok(format!("User-global memory follows. Treat it as fallible, possibly stale context subordinate to current user and project instructions. Verify memory claims before relying on them.\n<global-memory>\n{content}\n</global-memory>"))
        }))?;
        registration.policy(
            "memory_permission",
            Box::new(|request, _| {
                Box::pin(async move {
                    Ok(if request.tool == "memory" {
                        PolicyDecision::Allow
                    } else {
                        PolicyDecision::Abstain
                    })
                })
            }),
        )?;
        let store = self.store.clone();
        let redactor = self.redactor.clone();
        registration.tool("memory", Tool {
            title: Some(Box::new(|args, _| Ok(match args.get("operation").and_then(Value::as_str) {
                Some("read") => "Read global memory",
                Some("replace") => "Replace global memory",
                Some("clear") => "Clear global memory",
                _ => "Global memory",
            }.into()))),
            description: "Read or explicitly update the user's bounded global memory. Use replace or clear only when the user directly asks to remember, update, or forget something. Before changing memory, read it and preserve unrelated durable entries. Never store secrets, transient task state, or repository facts that should be verified from current files.".into(),
            parameters: serde_json::from_value(json!({"type":"object","properties":{"operation":{"type":"string","enum":["read","replace","clear"],"description":"Read the current memory, replace the complete document, or clear it"},"revision":{"type":"string","description":"Revision returned by the latest read; required for replace and clear"},"content":{"type":"string","description":"Complete replacement Markdown document; required for replace"}},"required":["operation"],"additionalProperties":false})).map_err(failure)?,
            effects: |args| if args.get("operation").and_then(Value::as_str) == Some("read") { Effects::Read } else { Effects::Write },
            concurrency: Some(|_| Concurrency::Exclusive),
            permission_subject: None,
            redact: Some(redact),
            available: Box::new(|session| Ok(session.kind != SessionKind::Task)),
            run: Box::new(move |args, context| {
                let store = store.clone();
                let redactor = redactor.clone();
                Box::pin(async move {
                    if context.session.kind == SessionKind::Task { return Err(Error::Denied("memory is unavailable in task sessions".into())); }
                    let input: Input = serde_json::from_value(Value::Object(args)).map_err(failure)?;
                    let output = blocking(&context.cancellation, move |cancelled| {
                        let protection = Protection::Redactor(&redactor);
                        let (content, revision) = match input {
                            Input::Read => return serde_json::to_string(&store.load(protection, cancelled)?).map_err(std::io::Error::other),
                            Input::Replace { content, revision } => {
                                if content.trim().is_empty() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "content is required for replace; use clear to erase global memory")); }
                                (content, revision)
                            },
                            Input::Clear { revision } => (String::new(), revision),
                        };
                        if revision.trim().is_empty() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "revision is required; read global memory before changing it")); }
                        let snapshot = store.replace(content, revision.trim(), protection, cancelled)?;
                        Ok(json!({"revision":snapshot.revision}).to_string())
                    }).await?;
                    Ok(ToolResult { output })
                })
            }),
        })
    }
    fn bootstrap<'a>(&'a mut self, registration: &'a mut Registration) -> Call<'a, ()> {
        let cancellation = registration.cancellation();
        let store = self.store.clone();
        let redactor = self.redactor.clone();
        Box::pin(async move {
            blocking(&cancellation, move |cancelled| {
                store.load(Protection::Redactor(&redactor), cancelled)
            })
            .await?;
            Ok(())
        })
    }
}
