use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde_json::{Value, json};
use xal_host::*;
use xal_services::search::*;
use xal_services::tool_contracts::ToolOutcomeKind;

use super::{failure, schema, text};

pub struct Search;

impl Plugin for Search {
    fn name(&self) -> &str {
        "search"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        for name in ["grep", "glob"] {
            let mut parameters = json!({"type":"object","properties":{"pattern":{"type":"string","minLength":1},"path":{"type":"string"}},"required":["pattern"],"additionalProperties":false});
            if name == "grep" {
                parameters["properties"]["glob"] = json!({"type":"string"});
                parameters["properties"]["output_mode"] =
                    json!({"type":"string","enum":["files","content"]});
                parameters["properties"]["case_insensitive"] = json!({"type":"boolean"});
            }
            registration.tool(name, Tool {
                description: if name == "grep" { "Search files with a Rust regular expression, honoring ignore rules. Returns up to 250 matching lines or file paths." } else { "List files matching a glob, honoring ignore rules. Up to 100 files, newest first." }.into(),
                parameters: schema(parameters), effects: Effects::read, redact: None, available: Box::new(|_| Ok(true)),
                run: Box::new(move |args, context| Box::pin(async move {
                    let cancelled = Arc::new(AtomicBool::new(false));
                    let flag = cancelled.clone();
                    let operation = tokio::task::spawn_blocking(move || {
                        let cwd = context.session.cwd.to_string_lossy().into_owned();
                        let target = args.get("path").and_then(Value::as_str).map(|path| xal_host::permissions::resolve_path(&context.session.cwd, path).map(|path| path.to_string_lossy().into_owned())).transpose()?;
                        let pattern = Some(text(&args, "pattern")?);
                        let result = if name == "grep" {
                            grep(GrepOptions { cwd, target, pattern, glob: args.get("glob").and_then(Value::as_str).map(str::to_owned), output_mode: args.get("output_mode").and_then(Value::as_str).map(str::to_owned), case_insensitive: args.get("case_insensitive").and_then(Value::as_bool), aborted: None }, flag).compute()
                        } else { glob(GlobOptions { cwd, target, pattern, aborted: None }, flag).compute() }.map_err(failure)?;
                        match result.kind {
                            ToolOutcomeKind::Completed => Ok(ToolResult { output: result.output.ok_or_else(|| Error::Failed("search output missing".into()))? }),
                            ToolOutcomeKind::Interrupted => Err(Error::Cancelled),
                            ToolOutcomeKind::TimedOut => Err(Error::Failed("search timed out".into())),
                            ToolOutcomeKind::Failed | ToolOutcomeKind::InvalidRequest => Err(Error::Failed(result.error.map_or_else(|| "search failed".into(), |error| error.message))),
                        }
                    });
                    tokio::pin!(operation);
                    tokio::select! {
                        biased;
                        () = context.cancellation.cancelled() => { cancelled.store(true, Ordering::Relaxed); operation.await.map_err(failure)? }
                        result = &mut operation => result.map_err(failure)?,
                    }
                })),
            })?;
        }
        Ok(())
    }
}
