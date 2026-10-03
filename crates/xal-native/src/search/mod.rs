#![cfg_attr(test, allow(dead_code))]
use crate::tool_contracts::{NativeToolError, NativeToolOutcomeKind, cancellation_flag};
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Task};
use napi_derive::napi;
mod glob;
mod grep;
#[napi(object)]
pub struct NativeSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub total: u32,
    pub lines: Vec<String>,
    pub output: Option<String>,
    pub error: Option<NativeToolError>,
}
impl From<xal_services::search::SearchResult> for NativeSearchResult {
    fn from(value: xal_services::search::SearchResult) -> Self {
        Self {
            kind: value.kind.into(),
            total: value.total,
            lines: value.lines,
            output: value.output,
            error: value.error.map(|error| NativeToolError {
                message: error.message,
            }),
        }
    }
}
pub(crate) fn walk_files(
    root: &std::path::Path,
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: Option<std::time::Instant>,
) -> napi::Result<Vec<std::path::PathBuf>> {
    xal_services::search::walk_files(root, cancelled, deadline)
        .map_err(crate::tool_contracts::io_error)
}
