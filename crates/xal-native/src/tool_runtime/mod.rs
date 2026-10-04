use std::collections::HashSet;

use napi::{Error, Status};
use napi_derive::napi;
use serde_json::{Map, Value, json};

const MAX_WAIT_SECONDS: f64 = 600.0;
const MAX_SCHEDULER_DURATION_MS: i64 = 12 * 60 * 60 * 1_000;
const MAX_EXTENSION_TURNS: i64 = 100;
const MAX_MESSAGE_LENGTH: usize = 20_000;
const MAX_CONTEXT_LENGTH: usize = 20_000;
const MAX_TASK_LENGTH: usize = 20_000;
const MAX_BATCH_TASKS: usize = 8;
const MAX_PLAN_LENGTH: usize = 50_000;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn object(value: &Value) -> napi::Result<&Map<String, Value>> {
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

fn required_string(value: &Map<String, Value>, name: &str) -> napi::Result<String> {
    string(value, name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{name} is required")))
}

fn parse_json(request: &str) -> napi::Result<Value> {
    serde_json::from_str(request).map_err(|_| invalid("native tool request is invalid JSON"))
}

fn encode(value: Value) -> napi::Result<String> {
    serde_json::to_string(&value)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn duration(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1_000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remainder = seconds % 60;
    if remainder == 0 {
        format!("{minutes}m")
    } else {
        format!("{minutes}m {remainder}s")
    }
}

mod input;
mod job;
mod memory;
mod plan;
mod scheduler;
mod task;

use input::{request_input_finalize, request_input_prepare};
use job::{
    agent_output, job_extend_finalize, job_extend_prepare, job_kill, job_prepare,
    job_send_finalize, job_send_prepare, job_status, process_output,
};
use memory::memory_prepare;
use plan::{submit_plan_finalize, submit_plan_prepare, submit_plan_review, update_plan};
use scheduler::{scheduler_finalize, scheduler_prepare};
use task::{task_context, task_finalize, task_items, task_prepare};

fn run(request: String, handler: fn(&Value) -> napi::Result<Value>) -> napi::Result<String> {
    encode(handler(&parse_json(&request)?)?)
}

#[napi]
pub struct NativeToolRuntime;

#[napi]
impl NativeToolRuntime {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self
    }

    #[napi(catch_unwind)]
    pub fn job_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_process_output(&self, request: String) -> napi::Result<String> {
        run(request, process_output)
    }
    #[napi(catch_unwind)]
    pub fn job_agent_output(&self, request: String) -> napi::Result<String> {
        run(request, agent_output)
    }
    #[napi(catch_unwind)]
    pub fn job_kill(&self, request: String) -> napi::Result<String> {
        run(request, job_kill)
    }
    #[napi(catch_unwind)]
    pub fn job_status(&self, request: String) -> napi::Result<String> {
        run(request, job_status)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_finalize)
    }
    #[napi(catch_unwind)]
    pub fn job_send_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_send_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_send_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_send_finalize)
    }
    #[napi(catch_unwind)]
    pub fn task_prepare(&self, request: String) -> napi::Result<String> {
        run(request, task_prepare)
    }
    #[napi(catch_unwind)]
    pub fn task_context(&self, request: String) -> napi::Result<String> {
        run(request, task_context)
    }
    #[napi(catch_unwind)]
    pub fn task_items(&self, request: String) -> napi::Result<String> {
        run(request, task_items)
    }
    #[napi(catch_unwind)]
    pub fn task_finalize(&self, request: String) -> napi::Result<String> {
        run(request, task_finalize)
    }
    #[napi(catch_unwind)]
    pub fn scheduler_prepare(&self, request: String) -> napi::Result<String> {
        run(request, scheduler_prepare)
    }
    #[napi(catch_unwind)]
    pub fn scheduler_finalize(&self, request: String) -> napi::Result<String> {
        run(request, scheduler_finalize)
    }
    #[napi(catch_unwind)]
    pub fn update_plan(&self, request: String) -> napi::Result<String> {
        run(request, update_plan)
    }
    #[napi(catch_unwind)]
    pub fn request_input_prepare(&self, request: String) -> napi::Result<String> {
        run(request, request_input_prepare)
    }
    #[napi(catch_unwind)]
    pub fn request_input_finalize(&self, request: String) -> napi::Result<String> {
        run(request, request_input_finalize)
    }
    #[napi(catch_unwind)]
    pub fn memory_prepare(&self, request: String) -> napi::Result<String> {
        run(request, memory_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_prepare(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_review(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_review)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_finalize(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_finalize)
    }
}
