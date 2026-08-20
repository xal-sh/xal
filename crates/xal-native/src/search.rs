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

#[napi(object)]
pub struct NativeGrepOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub glob: Option<String>,
    pub pattern: String,
    pub content: bool,
    pub case_insensitive: bool,
}

#[napi(object)]
pub struct NativeGlobOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub pattern: String,
}

#[napi(object)]
pub struct NativeSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub total: u32,
    pub lines: Vec<String>,
    pub error: Option<NativeToolError>,
}

fn search_result(kind: NativeToolOutcomeKind) -> NativeSearchResult {
    NativeSearchResult {
        kind,
        total: 0,
        lines: Vec::new(),
        error: None,
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
        error: Some(NativeToolError {
            message: first_line_message(prefix, error),
        }),
    }
}

fn absolute_target(cwd: &Path, target: Option<&str>) -> PathBuf {
    let Some(target) = target else {
        return cwd.to_path_buf();
    };
    let target = Path::new(target);
    normalize_path(&if target.is_absolute() {
        target.to_path_buf()
    } else {
        cwd.join(target)
    })
}

fn contains_git(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(value) if value == ".git"))
}

pub(crate) fn walk_files(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: Option<Instant>,
) -> napi::Result<Vec<PathBuf>> {
    if cancelled.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }
    if let Ok(metadata) = fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() {
            return Ok(Vec::new());
        }
        if metadata.is_file() {
            return Ok((!contains_git(root))
                .then(|| root.to_path_buf())
                .into_iter()
                .collect());
        }
    }
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .follow_links(false)
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git");
    let mut files = Vec::new();
    for entry in builder.build() {
        if cancelled.load(Ordering::Relaxed)
            || deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            break;
        }
        let entry = entry.map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(files)
}

fn display_path(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).map_or_else(
        |_| path.to_string_lossy().into_owned(),
        |path| path.to_string_lossy().into_owned(),
    )
}

fn path_for_glob(path: &Path, cwd: &Path, root: &Path) -> String {
    path.strip_prefix(cwd)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
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

enum SearchFile {
    Bytes(Vec<u8>),
    Binary,
    Interrupted,
    TimedOut,
}

struct CheckedCursor<'a> {
    cursor: Cursor<Vec<u8>>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}

impl Read for CheckedCursor<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) || Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "native search interrupted",
            ));
        }
        self.cursor.read(buffer)
    }
}

fn read_search_file(
    path: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<SearchFile, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(SearchFile::Interrupted);
        }
        if Instant::now() >= deadline {
            return Ok(SearchFile::TimedOut);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(SearchFile::Bytes(bytes));
        }
        if buffer[..read].contains(&0) {
            return Ok(SearchFile::Binary);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

pub struct GrepTask {
    options: NativeGrepOptions,
    cancelled: Arc<AtomicBool>,
}

impl Task for GrepTask {
    type Output = NativeSearchResult;
    type JsValue = NativeSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let deadline = Instant::now() + SEARCH_TIMEOUT;
        let cwd = PathBuf::from(&self.options.cwd);
        let root = absolute_target(&cwd, self.options.target.as_deref());
        let mut regex = RegexMatcherBuilder::new();
        regex.case_insensitive(self.options.case_insensitive);
        let matcher = match regex.build(&self.options.pattern) {
            Ok(matcher) => matcher,
            Err(error) => {
                return Ok(search_error(
                    NativeToolOutcomeKind::InvalidRequest,
                    "ripgrep error",
                    error,
                ));
            }
        };
        let glob = match self.options.glob.as_deref().map(compile_glob).transpose() {
            Ok(glob) => glob,
            Err(error) => return Ok(error),
        };
        let files = match walk_files(&root, &self.cancelled, Some(deadline)) {
            Ok(files) => files,
            Err(error) => {
                return Ok(search_error(
                    NativeToolOutcomeKind::Failed,
                    "ripgrep error",
                    error,
                ));
            }
        };
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(search_result(NativeToolOutcomeKind::Interrupted));
        }
        if Instant::now() >= deadline {
            return Ok(search_result(NativeToolOutcomeKind::TimedOut));
        }
        let mut result = search_result(NativeToolOutcomeKind::Completed);
        for path in files {
            if self.cancelled.load(Ordering::Relaxed) {
                result.kind = NativeToolOutcomeKind::Interrupted;
                result.total = 0;
                result.lines.clear();
                return Ok(result);
            }
            if Instant::now() >= deadline {
                result.kind = NativeToolOutcomeKind::TimedOut;
                result.total = 0;
                result.lines.clear();
                return Ok(result);
            }
            if glob
                .as_ref()
                .is_some_and(|glob| !glob.is_match(path_for_glob(&path, &cwd, &root)))
            {
                continue;
            }
            let bytes = match read_search_file(&path, &self.cancelled, deadline) {
                Ok(SearchFile::Bytes(bytes)) => bytes,
                Ok(SearchFile::Binary) => continue,
                Ok(SearchFile::Interrupted) => {
                    return Ok(search_result(NativeToolOutcomeKind::Interrupted));
                }
                Ok(SearchFile::TimedOut) => {
                    return Ok(search_result(NativeToolOutcomeKind::TimedOut));
                }
                Err(error) => {
                    return Ok(search_error(
                        NativeToolOutcomeKind::Failed,
                        "ripgrep error",
                        error,
                    ));
                }
            };
            let shown_path = display_path(&path, &cwd);
            let mut file_matched = false;
            let mut interrupted = false;
            let mut searcher = SearcherBuilder::new()
                .line_number(true)
                .binary_detection(BinaryDetection::quit(0))
                .build();
            let search = searcher.search_reader(
                &matcher,
                CheckedCursor {
                    cursor: Cursor::new(bytes),
                    cancelled: &self.cancelled,
                    deadline,
                },
                sinks::Lossy(|line_number, line| {
                    file_matched = true;
                    if !self.options.content {
                        return Ok(false);
                    }
                    result.total = result.total.saturating_add(1);
                    if result.lines.len() < GREP_LIMIT {
                        let line = line.strip_suffix('\n').unwrap_or(line);
                        let content = if line.len() > MAX_COLUMNS {
                            "[Omitted long matching line]"
                        } else {
                            line
                        };
                        result
                            .lines
                            .push(format!("{shown_path}:{line_number}:{content}"));
                    }
                    if self.cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                        interrupted = true;
                        return Ok(false);
                    }
                    Ok(true)
                }),
            );
            if let Err(error) = search {
                if self.cancelled.load(Ordering::Relaxed) {
                    return Ok(search_result(NativeToolOutcomeKind::Interrupted));
                }
                if Instant::now() >= deadline {
                    return Ok(search_result(NativeToolOutcomeKind::TimedOut));
                }
                return Ok(search_error(
                    NativeToolOutcomeKind::Failed,
                    "ripgrep error",
                    error,
                ));
            }
            if interrupted {
                if self.cancelled.load(Ordering::Relaxed) {
                    result.kind = NativeToolOutcomeKind::Interrupted;
                } else {
                    result.kind = NativeToolOutcomeKind::TimedOut;
                }
                result.total = 0;
                result.lines.clear();
                return Ok(result);
            }
            if file_matched && !self.options.content {
                result.total = result.total.saturating_add(1);
                if result.lines.len() < GREP_LIMIT {
                    result.lines.push(shown_path);
                }
            }
        }
        Ok(result)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeGrep", catch_unwind)]
pub fn native_grep(options: NativeGrepOptions, signal: Option<AbortSignal>) -> AsyncTask<GrepTask> {
    AsyncTask::new(GrepTask {
        options,
        cancelled: cancellation_flag(signal),
    })
}

struct GlobMatch {
    modified: SystemTime,
    path: String,
}

fn compare_glob(left: &GlobMatch, right: &GlobMatch) -> CompareOrdering {
    right
        .modified
        .cmp(&left.modified)
        .then_with(|| left.path.cmp(&right.path))
}

pub struct GlobTask {
    options: NativeGlobOptions,
    cancelled: Arc<AtomicBool>,
}

impl Task for GlobTask {
    type Output = NativeSearchResult;
    type JsValue = NativeSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let deadline = Instant::now() + SEARCH_TIMEOUT;
        let cwd = PathBuf::from(&self.options.cwd);
        let root = absolute_target(&cwd, self.options.target.as_deref());
        let matcher = match compile_glob(&self.options.pattern) {
            Ok(matcher) => matcher,
            Err(error) => return Ok(error),
        };
        let files = match walk_files(&root, &self.cancelled, Some(deadline)) {
            Ok(files) => files,
            Err(error) => {
                return Ok(search_error(
                    NativeToolOutcomeKind::Failed,
                    "ripgrep error",
                    error,
                ));
            }
        };
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(search_result(NativeToolOutcomeKind::Interrupted));
        }
        if Instant::now() >= deadline {
            return Ok(search_result(NativeToolOutcomeKind::TimedOut));
        }
        let mut retained = Vec::<GlobMatch>::new();
        let mut total = 0_u32;
        for path in files {
            if self.cancelled.load(Ordering::Relaxed) {
                return Ok(search_result(NativeToolOutcomeKind::Interrupted));
            }
            if Instant::now() >= deadline {
                return Ok(search_result(NativeToolOutcomeKind::TimedOut));
            }
            if !matcher.is_match(path_for_glob(&path, &cwd, &root)) {
                continue;
            }
            let modified = match fs::metadata(&path).and_then(|metadata| metadata.modified()) {
                Ok(modified) => modified,
                Err(error) => {
                    return Ok(search_error(
                        NativeToolOutcomeKind::Failed,
                        "ripgrep error",
                        error,
                    ));
                }
            };
            total = total.saturating_add(1);
            let entry = GlobMatch {
                modified,
                path: display_path(&path, &cwd),
            };
            if retained.len() < GLOB_LIMIT {
                retained.push(entry);
                continue;
            }
            let worst = retained
                .iter()
                .enumerate()
                .max_by(|(_, left), (_, right)| compare_glob(left, right))
                .map(|(index, _)| index)
                .unwrap_or(0);
            if compare_glob(&entry, &retained[worst]).is_lt() {
                retained[worst] = entry;
            }
        }
        retained.sort_by(compare_glob);
        Ok(NativeSearchResult {
            kind: NativeToolOutcomeKind::Completed,
            total,
            lines: retained.into_iter().map(|entry| entry.path).collect(),
            error: None,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeGlob", catch_unwind)]
pub fn native_glob(options: NativeGlobOptions, signal: Option<AbortSignal>) -> AsyncTask<GlobTask> {
    AsyncTask::new(GlobTask {
        options,
        cancelled: cancellation_flag(signal),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, atomic::AtomicBool};
    use std::time::{Duration, SystemTime};

    use super::{GlobMatch, compare_glob, walk_files};

    #[test]
    fn newest_glob_order_uses_path_as_tie_breaker() {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        let left = GlobMatch {
            modified: time,
            path: "a.txt".to_owned(),
        };
        let right = GlobMatch {
            modified: time,
            path: "b.txt".to_owned(),
        };
        assert!(compare_glob(&left, &right).is_lt());
    }

    #[test]
    fn walker_honors_ignore_and_includes_hidden_files() {
        let root = std::env::temp_dir().join(format!("xal-native-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).expect("fixture directory should be created");
        fs::write(root.join(".gitignore"), "ignored.txt\n").expect("ignore file should be written");
        fs::write(root.join("ignored.txt"), "ignored").expect("ignored fixture should be written");
        fs::write(root.join(".hidden"), "hidden").expect("hidden fixture should be written");
        fs::write(root.join("nested/visible.txt"), "visible")
            .expect("visible fixture should be written");
        let cancelled = Arc::new(AtomicBool::new(false));
        let files = walk_files(&root, &cancelled, None).expect("walk should succeed");
        assert!(files.windows(2).all(|paths| paths[0] <= paths[1]));
        assert!(files.iter().any(|path| path.ends_with(".hidden")));
        assert!(!files.iter().any(|path| path.ends_with("ignored.txt")));
        fs::remove_dir_all(root).expect("fixture should be removed");
    }
}
