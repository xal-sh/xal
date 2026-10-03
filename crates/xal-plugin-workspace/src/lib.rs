mod files;
mod search;
mod shell;
mod title;
mod web;
mod worktree;

pub use web::Web;
pub use worktree::Worktrees;

pub use files::Files;
pub use search::Search;
pub use shell::Shell;

use title::compact as compact_command_title;

use serde_json::Value;
use xal_host::{Error, JsonObject, Result};

fn text(args: &JsonObject, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Failed(format!("{key} must be a string")))
}

fn schema(value: Value) -> JsonObject {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("tool schemas are objects"),
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn renderer(
    registration: &mut xal_host::Registration,
    name: &str,
    summarize: fn(&str) -> String,
) -> Result<()> {
    registration.ui(
        name,
        Box::new(move |contribution, _| {
            Box::pin(async move {
                let xal_host::UiContribution::Tool { output, .. } = contribution else {
                    return Err(failure("tool renderer expects a tool result"));
                };
                Ok(summarize(&output))
            })
        }),
    )
}
