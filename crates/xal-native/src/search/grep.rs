use super::*;

#[napi(object)]
pub struct NativeGrepOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub glob: Option<String>,
    pub pattern: Option<String>,
    pub output_mode: Option<String>,
    pub case_insensitive: Option<bool>,
    pub literal: Option<bool>,
    pub multiline: Option<bool>,
    pub context: Option<u32>,
    pub offset: Option<u32>,
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

fn shown_line(line: &[u8]) -> String {
    let line = String::from_utf8_lossy(line);
    let line = line.strip_suffix('\n').unwrap_or(&line);
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.len() > MAX_COLUMNS {
        "[Omitted long matching line]".to_owned()
    } else {
        line.to_owned()
    }
}

struct GrepSink<'a> {
    shown_path: &'a str,
    content: bool,
    offset: u32,
    result: &'a mut NativeSearchResult,
    file_matched: bool,
    interrupted: bool,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    pending: Vec<String>,
    included: bool,
    broke: bool,
}

impl Sink for GrepSink<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        found: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        self.file_matched = true;
        if !self.content {
            return Ok(false);
        }
        let index = self.result.total;
        self.result.total = self.result.total.saturating_add(1);
        let before = std::mem::take(&mut self.pending);
        self.included = index >= self.offset && self.result.lines.len() < GREP_LIMIT;
        if self.included {
            let mut block = Vec::with_capacity(before.len() + 2);
            if self.broke && !self.result.lines.is_empty() {
                block.push("--".to_owned());
            }
            block.extend(before);
            let first = found.line_number().unwrap_or(0);
            for (index, line) in (0_u64..).zip(found.lines()) {
                block.push(format!(
                    "{}:{}:{}",
                    self.shown_path,
                    first + index,
                    shown_line(line)
                ));
            }
            self.result.lines.push(block.join("\n"));
        }
        self.broke = false;
        if self.cancelled.load(Ordering::Relaxed) || Instant::now() >= self.deadline {
            self.interrupted = true;
            return Ok(false);
        }
        Ok(true)
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        context: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        let line = format!(
            "{}-{}-{}",
            self.shown_path,
            context.line_number().unwrap_or(0),
            shown_line(context.bytes())
        );
        match context.kind() {
            SinkContextKind::After if self.included => {
                if let Some(block) = self.result.lines.last_mut() {
                    block.push('\n');
                    block.push_str(&line);
                }
            }
            SinkContextKind::After => {}
            SinkContextKind::Before | SinkContextKind::Other => self.pending.push(line),
        }
        Ok(true)
    }

    fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, Self::Error> {
        self.pending.clear();
        self.broke = true;
        Ok(true)
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
        let context = usize::try_from(self.options.context.unwrap_or(0)).unwrap_or(usize::MAX);
        if context > MAX_CONTEXT {
            return Ok(request_error("context must be at most 10 lines"));
        }
        let offset = self.options.offset.unwrap_or(0);
        let multiline = self.options.multiline.unwrap_or(false);
        let mut regex = RegexMatcherBuilder::new();
        regex.case_insensitive(self.options.case_insensitive.unwrap_or(false));
        regex.fixed_strings(self.options.literal.unwrap_or(false));
        regex.multi_line(true);
        if !multiline {
            regex.line_terminator(Some(b'\n'));
        }
        let matcher = match regex.build(pattern) {
            Ok(matcher) => matcher,
            Err(error) if matches!(error.kind(), RegexErrorKind::NotAllowed(_)) => {
                return Ok(search_error(
                    NativeToolOutcomeKind::InvalidRequest,
                    "ripgrep error",
                    format!("{error}. Set multiline to true to match across lines"),
                ));
            }
            Err(error) => {
                return Ok(search_error(
                    NativeToolOutcomeKind::InvalidRequest,
                    "ripgrep error",
                    error,
                ));
            }
        };
        let glob = match self
            .options
            .glob
            .as_deref()
            .map(|glob| GlobFilter::new(glob, &cwd, &root))
            .transpose()
        {
            Ok(glob) => glob,
            Err(error) => return Ok(error),
        };
        if let Some(missing) = missing_target(&root, &cwd) {
            return Ok(missing);
        }
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
        let mut searched = 0_usize;
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
            if glob.as_ref().is_some_and(|glob| !glob.is_match(&path)) {
                continue;
            }
            searched += 1;
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
            let mut searcher = SearcherBuilder::new()
                .line_number(true)
                .before_context(if content { context } else { 0 })
                .after_context(if content { context } else { 0 })
                .multi_line(multiline)
                .binary_detection(BinaryDetection::quit(0))
                .build();
            let mut sink = GrepSink {
                shown_path: &shown_path,
                content,
                offset,
                result: &mut result,
                file_matched: false,
                interrupted: false,
                cancelled: &self.cancelled,
                deadline,
                pending: Vec::new(),
                included: false,
                broke: context > 0,
            };
            let search = searcher.search_reader(
                &matcher,
                CheckedCursor {
                    cursor: Cursor::new(bytes),
                    cancelled: &self.cancelled,
                    deadline,
                },
                &mut sink,
            );
            let (file_matched, interrupted) = (sink.file_matched, sink.interrupted);
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
                let index = result.total;
                result.total = result.total.saturating_add(1);
                if index >= offset && result.lines.len() < GREP_LIMIT {
                    result.lines.push(shown_path);
                }
            }
        }
        if searched == 0
            && let Some(glob) = self.options.glob.as_deref()
        {
            result.output = Some(format!(
                "No files match glob {glob}, so nothing was searched. Globs match paths relative to the search path or the working directory."
            ));
            return Ok(result);
        }
        Ok(complete_grep(result, content, multiline, offset))
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
