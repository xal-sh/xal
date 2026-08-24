#![cfg_attr(test, allow(dead_code))]

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

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

fn canonical_target(path: &Path) -> napi::Result<PathBuf> {
    let mut current = path.to_path_buf();
    let mut suffix: Vec<OsString> = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(mut target) => {
                for part in suffix.iter().rev() {
                    target.push(part);
                }
                return Ok(target);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                if fs::symlink_metadata(&current)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(failed(format!(
                        "Cannot resolve file boundary: {}",
                        path.display()
                    )));
                }
                let name = current.file_name().ok_or_else(|| {
                    failed(format!("Cannot resolve file boundary: {}", path.display()))
                })?;
                suffix.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| {
                        failed(format!("Cannot resolve file boundary: {}", path.display()))
                    })?
                    .to_path_buf();
            }
            Err(error) => return Err(io_error(error)),
        }
    }
}

fn validate_expected_path(path: &Path, expected_path: Option<String>) -> napi::Result<()> {
    let expected = required_path(expected_path)?;
    let current = canonical_target(path)?;
    if current == expected {
        return Ok(());
    }
    Err(failed(format!(
        "File boundary changed before execution: {}",
        path.display()
    )))
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

#[cfg(test)]
mod boundary_tests {
    use std::fs;

    use super::validate_expected_path;

    #[test]
    fn rejects_a_file_target_that_changed_after_validation() {
        let root =
            std::env::temp_dir().join(format!("xal-native-boundary-test-{}", std::process::id()));
        let path = root.join("file.txt");
        fs::create_dir_all(&root).expect("fixture directory should exist");
        fs::write(&path, "content").expect("fixture should write");
        let expected = fs::canonicalize(&path)
            .expect("fixture should resolve")
            .display()
            .to_string();
        assert!(validate_expected_path(&path, Some(expected)).is_ok());
        assert!(
            validate_expected_path(&path, Some(root.join("other.txt").display().to_string()))
                .is_err()
        );
        fs::remove_dir_all(root).expect("fixture should clean up");
    }
}

#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    unified_diff(&old_text, &new_text).into()
}
