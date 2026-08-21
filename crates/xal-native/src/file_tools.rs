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

#[napi(object)]
pub struct NativeReadRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub offset: Option<f64>,
    pub limit: Option<f64>,
}

#[napi(object)]
pub struct NativeEditRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub old_string: Option<Utf16String>,
    pub new_string: Option<Utf16String>,
    pub replace_all: Option<bool>,
}

#[napi(object)]
pub struct NativeWriteRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub content: Option<Utf16String>,
}

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

pub struct ReadTask {
    path: PathBuf,
    display_path: String,
    offset: usize,
    limit: usize,
}

impl Task for ReadTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path)
            .map_err(|_| failed(format!("File not found: {}", self.display_path)))?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let file = fs::File::open(&self.path).map_err(io_error)?;
        let mut reader = BufReader::new(file);
        let mut buffer = Vec::new();
        let mut output = Vec::<u16>::new();
        let mut total = 0_usize;
        let mut shown = 0_usize;
        let mut end = self.offset.saturating_sub(1);
        let mut retaining = true;
        loop {
            buffer.clear();
            let read = reader.read_until(b'\n', &mut buffer).map_err(io_error)?;
            if read == 0 {
                break;
            }
            if buffer.contains(&0) {
                return Err(failed(format!(
                    "Cannot read binary file: {}",
                    self.display_path
                )));
            }
            if buffer.last() == Some(&b'\n') {
                buffer.pop();
            }
            total += 1;
            if total < self.offset || shown >= self.limit || !retaining {
                continue;
            }
            let source = String::from_utf8_lossy(&buffer);
            let mut row = format!("{:>6}: ", total).encode_utf16().collect::<Vec<_>>();
            row.extend(truncate_line(&source));
            if output.len() + row.len() + 1 > MAX_OUTPUT_UNITS && !output.is_empty() {
                retaining = false;
                continue;
            }
            output.extend(row);
            output.push(b'\n' as u16);
            shown += 1;
            end = total;
        }
        let total_output = checked_count(total, "read line")?;
        if total == 0 {
            return Ok(NativeToolOutput {
                output: "(empty file)".to_owned().into(),
            });
        }
        if self.offset > total {
            return Err(failed(format!(
                "Offset {} is past the end of the file ({total_output} lines)",
                self.offset
            )));
        }
        let footer = if end >= total {
            format!("(End of file - {total} lines)")
        } else {
            format!(
                "(Showing lines {}-{end} of {total}. Use offset={} to continue.)",
                self.offset,
                end + 1
            )
        };
        output.extend(footer.encode_utf16());
        Ok(NativeToolOutput {
            output: output.into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeReadFile", catch_unwind)]
pub fn native_read_file(request: NativeReadRequest) -> napi::Result<AsyncTask<ReadTask>> {
    Ok(AsyncTask::new(ReadTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        offset: normalized_count(request.offset, 1) as usize,
        limit: normalized_count(request.limit, DEFAULT_READ_LIMIT) as usize,
    }))
}

fn match_positions(haystack: &[u16], needle: &[u16]) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut positions = Vec::new();
    let mut cursor = 0;
    while cursor + needle.len() <= haystack.len() {
        let Some(relative) = haystack[cursor..]
            .windows(needle.len())
            .position(|window| window == needle)
        else {
            break;
        };
        let position = cursor + relative;
        positions.push(position);
        cursor = position + needle.len();
    }
    positions
}

fn replace_matches(
    previous: &[u16],
    old: &[u16],
    new: &[u16],
    positions: &[usize],
    replace_all: bool,
) -> Vec<u16> {
    let count = if replace_all { positions.len() } else { 1 };
    let mut next = Vec::with_capacity(previous.len());
    let mut cursor = 0;
    for position in positions.iter().take(count).copied() {
        next.extend_from_slice(&previous[cursor..position]);
        next.extend_from_slice(new);
        cursor = position + old.len();
    }
    next.extend_from_slice(&previous[cursor..]);
    next
}

pub struct EditTask {
    path: PathBuf,
    display_path: String,
    old: Vec<u16>,
    new: Vec<u16>,
    replace_all: bool,
}

impl Task for EditTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path)
            .map_err(|_| failed(format!("File not found: {}", self.display_path)))?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let previous_text =
            String::from_utf8(fs::read(&self.path).map_err(io_error)?).map_err(|error| {
                invalid(format!(
                    "Cannot edit binary file {}: {error}",
                    self.display_path
                ))
            })?;
        let previous = previous_text.encode_utf16().collect::<Vec<_>>();
        let positions = match_positions(&previous, &self.old);
        let matches = checked_count(positions.len(), "edit match")?;
        if positions.is_empty() {
            return Err(failed(format!(
                "old_string not found in {}. It must match the file text exactly, including whitespace and indentation.",
                self.display_path
            )));
        }
        if positions.len() > 1 && !self.replace_all {
            return Err(failed(format!(
                "old_string matches {matches} locations in {}. Add surrounding lines to make it unique, or set replace_all to true.",
                self.display_path
            )));
        }
        let next = replace_matches(
            &previous,
            &self.old,
            &self.new,
            &positions,
            self.replace_all,
        );
        let diff = unified_diff(&previous, &next);
        fs::write(&self.path, utf16_lossy(&next).as_bytes()).map_err(io_error)?;
        Ok(NativeToolOutput {
            output: with_diff(
                format!(
                    "Updated {} (+{} -{})",
                    self.display_path, diff.added, diff.removed
                ),
                &diff.hunks,
            )
            .into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(request: NativeEditRequest) -> napi::Result<AsyncTask<EditTask>> {
    let old = request
        .old_string
        .ok_or_else(|| invalid("old_string is required and must be non-empty"))?;
    if old.is_empty() {
        return Err(invalid("old_string is required and must be non-empty"));
    }
    let new = request
        .new_string
        .ok_or_else(|| invalid("new_string is required"))?;
    if old.to_vec() == new.to_vec() {
        return Err(invalid(
            "old_string and new_string are identical; nothing to change",
        ));
    }
    Ok(AsyncTask::new(EditTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        old: old.to_vec(),
        new: new.to_vec(),
        replace_all: request.replace_all.unwrap_or(false),
    }))
}

pub struct WriteTask {
    path: PathBuf,
    display_path: String,
    content: Vec<u16>,
}

impl Task for WriteTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path).ok();
        if metadata.as_ref().is_some_and(fs::Metadata::is_dir) {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let previous = match metadata {
            Some(_) => Some(
                String::from_utf8(fs::read(&self.path).map_err(io_error)?)
                    .map_err(|error| {
                        invalid(format!(
                            "Cannot write to binary file {}: {error}",
                            self.display_path
                        ))
                    })?
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            ),
            None => None,
        };
        if previous.as_deref() == Some(&self.content) {
            return Ok(NativeToolOutput {
                output: format!("Unchanged {}", self.display_path).into(),
            });
        }
        let diff = unified_diff(previous.as_deref().unwrap_or(&[]), &self.content);
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(&self.path, utf16_lossy(&self.content).as_bytes()).map_err(io_error)?;
        let header = if previous.is_some() {
            format!(
                "Updated {} (+{} -{})",
                self.display_path, diff.added, diff.removed
            )
        } else {
            format!("Created {} ({} lines)", self.display_path, diff.added)
        };
        Ok(NativeToolOutput {
            output: with_diff(header, &diff.hunks).into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeWriteFile", catch_unwind)]
pub fn native_write_file(request: NativeWriteRequest) -> napi::Result<AsyncTask<WriteTask>> {
    let content = request
        .content
        .ok_or_else(|| invalid("content is required"))?;
    Ok(AsyncTask::new(WriteTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        content: content.to_vec(),
    }))
}

#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    unified_diff(&old_text, &new_text).into()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use napi::Task;

    use super::{WriteTask, match_positions, normalized_count, replace_matches};

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn counts_non_overlapping_utf16_matches() {
        let previous = units("same same same");
        let old = units("same");
        let positions = match_positions(&previous, &old);
        assert_eq!(positions, vec![0, 5, 10]);
        assert_eq!(
            replace_matches(&previous, &old, &units("next"), &positions, true),
            units("next next next")
        );
        assert!(match_positions(&previous, &[]).is_empty());
    }

    #[test]
    fn rejects_non_utf8_files_in_write_comparisons() {
        let path =
            std::env::temp_dir().join(format!("xal-native-write-test-{}.bin", std::process::id()));
        fs::write(&path, [0xff]).expect("fixture should write");
        let mut task = WriteTask {
            path: path.clone(),
            display_path: path.display().to_string(),
            content: units("�"),
        };
        assert!(task.compute().is_err());
        fs::remove_file(path).expect("fixture should clean up");
    }

    #[test]
    fn normalizes_read_counts() {
        assert_eq!(normalized_count(None, 2000), 2000);
        assert_eq!(normalized_count(Some(-4.0), 2000), 1);
        assert_eq!(normalized_count(Some(3.9), 2000), 3);
        assert_eq!(normalized_count(Some(f64::INFINITY), 2000), 1);
        assert_eq!(
            normalized_count(Some(f64::from(u32::MAX) * 2.0), 2000),
            u32::MAX
        );
    }
}
