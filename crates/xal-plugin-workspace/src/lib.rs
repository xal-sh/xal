mod files;
mod search;
mod shell;

pub use files::Files;
pub use search::Search;
pub use shell::Shell;

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
