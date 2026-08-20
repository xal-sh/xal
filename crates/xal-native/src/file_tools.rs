#![cfg_attr(test, allow(dead_code))]

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use napi::bindgen_prelude::{AsyncTask, Utf16String};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::diff::{DiffOutput, unified_diff};

const MAX_OUTPUT_UNITS: usize = 50_000;
const MAX_LINE_UNITS: usize = 2000;

#[napi(object)]
pub struct NativeReadResult {
    pub kind: String,
    pub text: Option<Utf16String>,
    pub total: u32,
}

#[napi(object)]
pub struct NativeFileResult {
    pub kind: String,
    pub hunks: Option<Utf16String>,
    pub added: u32,
    pub removed: u32,
    pub matches: u32,
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

fn read_kind(kind: &str) -> NativeReadResult {
    NativeReadResult {
        kind: kind.to_owned(),
        text: None,
        total: 0,
    }
}

fn file_kind(kind: &str) -> NativeFileResult {
    NativeFileResult {
        kind: kind.to_owned(),
        hunks: None,
        added: 0,
        removed: 0,
        matches: 0,
    }
}

fn file_diff(kind: &str, diff: DiffOutput) -> NativeFileResult {
    NativeFileResult {
        kind: kind.to_owned(),
        hunks: Some(diff.hunks.into()),
        added: diff.added,
        removed: diff.removed,
        matches: 0,
    }
}

fn io_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn units_to_string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn truncate_line(line: &str) -> Vec<u16> {
    let units = line.encode_utf16().collect::<Vec<_>>();
    if units.len() <= MAX_LINE_UNITS {
        return units;
    }
    let mut truncated = units[..MAX_LINE_UNITS].to_vec();
    truncated.extend("… (line truncated)".encode_utf16());
    truncated
}

pub struct ReadTask {
    path: PathBuf,
    offset: usize,
    limit: usize,
}

impl Task for ReadTask {
    type Output = NativeReadResult;
    type JsValue = NativeReadResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(read_kind("notFound")),
        };
        if metadata.is_dir() {
            return Ok(read_kind("directory"));
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
                return Ok(read_kind("binary"));
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
        let total_output = u32::try_from(total).unwrap_or(u32::MAX);
        if total == 0 {
            let mut result = read_kind("empty");
            result.total = total_output;
            return Ok(result);
        }
        if self.offset > total {
            let mut result = read_kind("pastEnd");
            result.total = total_output;
            return Ok(result);
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
        Ok(NativeReadResult {
            kind: "completed".to_owned(),
            text: Some(output.into()),
            total: total_output,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeReadFile", catch_unwind)]
pub fn native_read_file(path: String, offset: u32, limit: u32) -> AsyncTask<ReadTask> {
    AsyncTask::new(ReadTask {
        path: PathBuf::from(path),
        offset: offset as usize,
        limit: limit as usize,
    })
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
    old: Vec<u16>,
    new: Vec<u16>,
    replace_all: bool,
}

impl Task for EditTask {
    type Output = NativeFileResult;
    type JsValue = NativeFileResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(file_kind("notFound")),
        };
        if metadata.is_dir() {
            return Ok(file_kind("directory"));
        }
        let previous_text = String::from_utf8(fs::read(&self.path).map_err(io_error)?)
            .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
        let previous = previous_text.encode_utf16().collect::<Vec<_>>();
        let positions = match_positions(&previous, &self.old);
        let matches = u32::try_from(positions.len()).unwrap_or(u32::MAX);
        if positions.is_empty() {
            let mut result = file_kind("noMatch");
            result.matches = matches;
            return Ok(result);
        }
        if positions.len() > 1 && !self.replace_all {
            let mut result = file_kind("ambiguous");
            result.matches = matches;
            return Ok(result);
        }
        let next = replace_matches(
            &previous,
            &self.old,
            &self.new,
            &positions,
            self.replace_all,
        );
        let diff = unified_diff(&previous, &next);
        let next_text = units_to_string(&next);
        fs::write(&self.path, next_text.as_bytes()).map_err(io_error)?;
        let mut result = file_diff("updated", diff);
        result.matches = matches;
        Ok(result)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(
    path: String,
    old: Utf16String,
    new: Utf16String,
    replace_all: bool,
) -> napi::Result<AsyncTask<EditTask>> {
    if old.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "old string must be non-empty".to_owned(),
        ));
    }
    Ok(AsyncTask::new(EditTask {
        path: PathBuf::from(path),
        old: old.to_vec(),
        new: new.to_vec(),
        replace_all,
    }))
}

pub struct WriteTask {
    path: PathBuf,
    content: Vec<u16>,
}

impl Task for WriteTask {
    type Output = NativeFileResult;
    type JsValue = NativeFileResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path).ok();
        if metadata.as_ref().is_some_and(fs::Metadata::is_dir) {
            return Ok(file_kind("directory"));
        }
        let previous = match metadata {
            Some(_) => Some(
                String::from_utf8_lossy(&fs::read(&self.path).map_err(io_error)?)
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            ),
            None => None,
        };
        if previous.as_deref() == Some(&self.content) {
            return Ok(file_kind("unchanged"));
        }
        let diff = unified_diff(previous.as_deref().unwrap_or(&[]), &self.content);
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let content = units_to_string(&self.content);
        fs::write(&self.path, content.as_bytes()).map_err(io_error)?;
        Ok(file_diff(
            if previous.is_some() {
                "updated"
            } else {
                "created"
            },
            diff,
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeWriteFile", catch_unwind)]
pub fn native_write_file(path: String, content: Utf16String) -> AsyncTask<WriteTask> {
    AsyncTask::new(WriteTask {
        path: PathBuf::from(path),
        content: content.to_vec(),
    })
}

#[napi(js_name = "nativeUnifiedDiff", catch_unwind)]
pub fn native_unified_diff(old_text: Utf16String, new_text: Utf16String) -> NativeDiffResult {
    unified_diff(&old_text, &new_text).into()
}

#[cfg(test)]
mod tests {
    use super::{match_positions, replace_matches};

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
}
