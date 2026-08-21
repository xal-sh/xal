#![cfg_attr(test, allow(dead_code))]

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use napi::bindgen_prelude::{AsyncTask, Utf16String};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::diff::{DiffOutput, unified_diff};
use crate::tool_contracts::{checked_count, truncate_utf16, utf16_lossy};

const DEFAULT_READ_LIMIT: u32 = 2000;
const MAX_OUTPUT_UNITS: usize = 50_000;
const MAX_LINE_UNITS: usize = 2000;

mod edit;
mod read;
mod write;

#[napi(object)]
pub struct NativeToolOutput {
    pub output: Utf16String,
}

#[napi(object)]
pub struct NativeDiffResult {
    pub hunks: Utf16String,
    pub added: u32,
    pub removed: u32,
}

impl From<DiffOutput> for NativeDiffResult {
    fn from(value: DiffOutput) -> Self {
        Self {
            hunks: value.hunks.into(),
            added: value.added,
            removed: value.removed,
        }
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn io_error(error: impl std::fmt::Display) -> Error {
    failed(error.to_string())
}

fn required_path(path: Option<String>) -> napi::Result<PathBuf> {
    let path = path
        .filter(|path| !path.is_empty())
        .ok_or_else(|| invalid("file_path is required"))?;
    Ok(PathBuf::from(path))
}

fn normalized_count(value: Option<f64>, default: u32) -> u32 {
    let value = value.unwrap_or(f64::from(default));
    if !value.is_finite() || value < 1.0 {
        return 1;
    }
    value.floor().min(f64::from(u32::MAX)) as u32
}

fn truncate_line(line: &str) -> Vec<u16> {
    truncate_utf16(line, MAX_LINE_UNITS, "… (line truncated)")
}

fn with_diff(header: String, hunks: &[u16]) -> Vec<u16> {
    let mut output = header.encode_utf16().collect::<Vec<_>>();
    if hunks.is_empty() {
        return output;
    }
    output.push(b'\n' as u16);
    output.extend_from_slice(hunks);
    output
}

#[cfg(test)]
fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    unified_diff(&old_text, &new_text).into()
}
