use super::*;

#[napi(object)]
pub struct NativeGrepOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub glob: Option<String>,
    pub pattern: Option<String>,
    pub output_mode: Option<String>,
    pub case_insensitive: Option<bool>,
    pub aborted: Option<bool>,
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
        if self.options.aborted.unwrap_or(false) {
            return Ok(search_result(NativeToolOutcomeKind::Interrupted));
        }
        let deadline = Instant::now() + SEARCH_TIMEOUT;
        let cwd = PathBuf::from(&self.options.cwd);
        let root = absolute_target(&cwd, self.options.target.as_deref());
        let Some(pattern) = self
            .options
            .pattern
            .as_deref()
            .filter(|pattern| !pattern.is_empty())
        else {
            return Ok(request_error("pattern is required"));
        };
        let content = self.options.output_mode.as_deref() != Some("files");
        let mut regex = RegexMatcherBuilder::new();
        regex.case_insensitive(self.options.case_insensitive.unwrap_or(false));
        let matcher = match regex.build(pattern) {
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
                    if !content {
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
            if file_matched && !content {
                result.total = result.total.saturating_add(1);
                if result.lines.len() < GREP_LIMIT {
                    result.lines.push(shown_path);
                }
            }
        }
        Ok(complete_grep(result, content))
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
