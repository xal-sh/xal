use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use tokio::runtime::Runtime;
use xal_services::mcp::{McpCall, McpManager, PromptRequest, ResourceRequest, ToolCallRequest};

use crate::tool_contracts::cancellation_flag;

mod call;
mod manager;
mod task;

use call::NativeMcpCall;
use task::{ManagerOperation, ManagerTask};

fn failure(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn parse<T: serde::de::DeserializeOwned>(value: &str) -> napi::Result<T> {
    serde_json::from_str(value).map_err(|error| Error::new(Status::InvalidArg, error.to_string()))
}
