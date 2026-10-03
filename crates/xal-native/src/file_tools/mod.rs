#![cfg_attr(test, allow(dead_code))]

use napi::bindgen_prelude::{AsyncTask, Utf16String};
use napi::{Env, Task};
use napi_derive::napi;

mod edit;
mod read;
mod write;

#[napi(object)]
pub struct NativeToolOutput {
    pub output: Utf16String,
}

#[napi(object)]
pub struct NativeFileToolOutput {
    pub output: Utf16String,
    pub content_hash: String,
}

impl From<xal_services::file_tools::FileToolOutput> for NativeFileToolOutput {
    fn from(value: xal_services::file_tools::FileToolOutput) -> Self {
        Self {
            output: value.output.into(),
            content_hash: value.content_hash,
        }
    }
}
#[napi(object)]
pub struct NativeDiffResult {
    pub hunks: Utf16String,
    pub added: u32,
    pub removed: u32,
}
#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    let diff = xal_services::diff::unified_diff(&old_text, &new_text);
    NativeDiffResult {
        hunks: diff.hunks.into(),
        added: diff.added,
        removed: diff.removed,
    }
}
