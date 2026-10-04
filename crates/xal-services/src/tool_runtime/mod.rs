use std::collections::HashSet;

use serde_json::{Map, Value, json};
use std::io::{self, Error};

const MAX_WAIT_SECONDS: f64 = 600.0;
const MAX_SCHEDULER_DURATION_MS: i64 = 12 * 60 * 60 * 1_000;
const MAX_CONTEXT_LENGTH: usize = 20_000;
const MAX_TASK_LENGTH: usize = 20_000;
const MAX_BATCH_TASKS: usize = 8;
const MAX_PLAN_LENGTH: usize = 50_000;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn object(value: &Value) -> io::Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid("native tool request must be an object"))
}

fn string<'a>(value: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}

fn integer(value: &Map<String, Value>, name: &str) -> Option<i64> {
    value.get(name).and_then(Value::as_i64)
}

fn required_string(value: &Map<String, Value>, name: &str) -> io::Result<String> {
    string(value, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{name} is required")))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

mod input;
mod job;
mod plan;
mod scheduler;
mod task;

pub use input::request_input_prepare;
pub use job::{job_prepare, process_output};
pub use plan::{submit_plan_finalize, submit_plan_prepare, submit_plan_review, update_plan};
pub use scheduler::{scheduler_finalize, scheduler_prepare};
pub use task::{task_finalize, task_prepare};
