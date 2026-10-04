#![cfg_attr(test, allow(dead_code))]

use std::cmp::Ordering as CompareOrdering;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant, SystemTime};

use globset::{Glob, GlobMatcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, sinks};
use ignore::WalkBuilder;
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::tool_contracts::{
    NativeToolError, NativeToolOutcomeKind, cancellation_flag, first_line_message, normalize_path,
};

const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const GREP_LIMIT: usize = 250;
const GLOB_LIMIT: usize = 100;
const MAX_COLUMNS: usize = 500;
const MAX_OUTPUT_CHARS: usize = 30_000;

mod glob;
mod grep;
mod walk;

pub(crate) use walk::walk_files;
use walk::{absolute_target, display_path, path_for_glob};

#[napi(object)]
pub struct NativeSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub total: u32,
    pub lines: Vec<String>,
    pub output: Option<String>,
    pub error: Option<NativeToolError>,
}

fn search_result(kind: NativeToolOutcomeKind) -> NativeSearchResult {
    NativeSearchResult {
        kind,
        total: 0,
        lines: Vec::new(),
        output: None,
        error: None,
    }
}

fn request_error(message: &str) -> NativeSearchResult {
    NativeSearchResult {
        kind: NativeToolOutcomeKind::InvalidRequest,
        total: 0,
        lines: Vec::new(),
        output: None,
        error: Some(NativeToolError {
            message: message.to_owned(),
        }),
    }
}

fn search_error(
    kind: NativeToolOutcomeKind,
    prefix: &str,
    error: impl std::fmt::Display,
) -> NativeSearchResult {
    NativeSearchResult {
        kind,
        total: 0,
        lines: Vec::new(),
        output: None,
        error: Some(NativeToolError {
            message: first_line_message(prefix, error),
        }),
    }
}

fn format_results(
    header: &str,
    lines: &[String],
    total: u32,
    footer: impl FnOnce(usize) -> String,
) -> String {
    let mut shown = lines.to_vec();
    let mut characters = shown
        .iter()
        .map(|line| line.encode_utf16().count() + 1)
        .sum::<usize>();
    while shown.len() > 1 && characters > MAX_OUTPUT_CHARS {
        characters -= shown
            .pop()
            .map_or(0, |line| line.encode_utf16().count() + 1);
    }
    let mut output = Vec::with_capacity(shown.len() + 2);
    output.push(header.to_owned());
    output.extend(shown.iter().cloned());
    if usize::try_from(total).is_ok_and(|total| total > shown.len()) {
        output.push(footer(shown.len()));
    }
    output.join("\n")
}

fn complete_grep(mut result: NativeSearchResult, content: bool) -> NativeSearchResult {
    result.output = Some(if result.total == 0 {
        "No matches found".to_owned()
    } else {
        let header = if content {
            format!("Found {} matching lines", result.total)
        } else {
            format!("Found {} files", result.total)
        };
        format_results(&header, &result.lines, result.total, |shown| {
            format!(
                "(Showing first {shown} of {}. Narrow your pattern or path.)",
                result.total
            )
        })
    });
    result
}

fn complete_glob(mut result: NativeSearchResult) -> NativeSearchResult {
    result.output = Some(if result.total == 0 {
        "No files found".to_owned()
    } else {
        let header = format!("Found {} files", result.total);
        format_results(&header, &result.lines, result.total, |shown| {
            format!(
                "(Showing first {shown} of {}. Narrow the pattern to see the rest.)",
                result.total
            )
        })
    });
    result
}

fn compile_glob(pattern: &str) -> Result<GlobMatcher, NativeSearchResult> {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher())
        .map_err(|error| {
            search_error(
                NativeToolOutcomeKind::InvalidRequest,
                "ripgrep error",
                error,
            )
        })
}
