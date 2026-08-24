#![cfg_attr(test, allow(dead_code))]

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
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

fn validate_expected_path(path: &Path, expected_path: &str) -> napi::Result<()> {
    let expected = required_path(Some(expected_path.to_string()))?;
    let current = canonical_target(path)?;
    if current == expected {
        return Ok(());
    }
    Err(failed(format!(
        "File boundary changed before execution: {}",
        path.display()
    )))
}

struct StableTarget {
    directory: Dir,
    path: PathBuf,
}

fn stable_target(
    path: &Path,
    expected_path: &str,
    create_parent: bool,
) -> napi::Result<StableTarget> {
    validate_expected_path(path, expected_path)?;
    let expected = required_path(Some(expected_path.to_string()))?;
    let name = expected
        .file_name()
        .ok_or_else(|| failed(format!("Cannot open file boundary: {}", expected.display())))?;
    let mut ancestor = expected
        .parent()
        .ok_or_else(|| failed(format!("Cannot open file boundary: {}", expected.display())))?;
    let mut relative = PathBuf::from(name);
    while !ancestor.is_dir() {
        let part = ancestor
            .file_name()
            .ok_or_else(|| failed(format!("Cannot open file boundary: {}", expected.display())))?;
        relative = PathBuf::from(part).join(relative);
        ancestor = ancestor
            .parent()
            .ok_or_else(|| failed(format!("Cannot open file boundary: {}", expected.display())))?;
    }
    let directory = Dir::open_ambient_dir(ancestor, ambient_authority()).map_err(io_error)?;
    validate_expected_path(path, expected_path)?;
    if create_parent {
        let parent = relative
            .parent()
            .ok_or_else(|| failed(format!("Cannot open file boundary: {}", expected.display())))?;
        directory.create_dir_all(parent).map_err(io_error)?;
    }
    Ok(StableTarget {
        directory,
        path: relative,
    })
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
    #[cfg(unix)]
    use std::io::Read;

    use super::{stable_target, validate_expected_path};

    #[cfg(unix)]
    fn symlink_dir(target: &std::path::Path, link: &std::path::Path) {
        std::os::unix::fs::symlink(target, link).expect("fixture symlink should exist");
    }

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
        assert!(validate_expected_path(&path, &expected).is_ok());
        assert!(
            validate_expected_path(&path, &root.join("other.txt").display().to_string()).is_err()
        );
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_file_access_bound_to_the_opened_directory() {
        let root = std::env::temp_dir().join(format!(
            "xal-native-stable-boundary-test-{}",
            std::process::id()
        ));
        let internal = root.join("internal");
        let moved = root.join("moved");
        let external = root.join("external");
        fs::create_dir_all(&internal).expect("internal fixture should exist");
        fs::create_dir_all(&external).expect("external fixture should exist");
        fs::write(internal.join("file.txt"), "internal").expect("internal fixture should write");
        fs::write(external.join("file.txt"), "external").expect("external fixture should write");
        let path = internal.join("file.txt");
        let expected = fs::canonicalize(&path)
            .expect("fixture should resolve")
            .display()
            .to_string();
        let target = stable_target(&path, &expected, false).expect("stable target should open");
        fs::rename(&internal, &moved).expect("internal fixture should move");
        symlink_dir(&external, &internal);
        let mut content = String::new();
        target
            .directory
            .open(&target.path)
            .expect("stable file should open")
            .read_to_string(&mut content)
            .expect("stable file should read");
        assert_eq!(content, "internal");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }
}

#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    unified_diff(&old_text, &new_text).into()
}
