use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::AbortSignal;
use napi_derive::napi;

#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeToolOutcomeKind {
    Completed,
    Interrupted,
    TimedOut,
    InvalidRequest,
    Failed,
}

#[napi(object)]
pub struct NativeToolError {
    pub message: String,
}

impl From<xal_services::tool_contracts::ToolOutcomeKind> for NativeToolOutcomeKind {
    fn from(value: xal_services::tool_contracts::ToolOutcomeKind) -> Self {
        use xal_services::tool_contracts::ToolOutcomeKind;
        match value {
            ToolOutcomeKind::Completed => Self::Completed,
            ToolOutcomeKind::Interrupted => Self::Interrupted,
            ToolOutcomeKind::TimedOut => Self::TimedOut,
            ToolOutcomeKind::InvalidRequest => Self::InvalidRequest,
            ToolOutcomeKind::Failed => Self::Failed,
        }
    }
}
pub fn io_error(error: std::io::Error) -> napi::Error {
    let status = if error.kind() == std::io::ErrorKind::InvalidInput {
        napi::Status::InvalidArg
    } else {
        napi::Status::GenericFailure
    };
    napi::Error::new(status, error.to_string())
}

pub fn cancellation_flag(signal: Option<AbortSignal>) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = signal {
        let task_cancelled = cancelled.clone();
        signal.on_abort(move || task_cancelled.store(true, Ordering::Relaxed));
    }
    cancelled
}
