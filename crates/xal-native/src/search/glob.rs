use super::*;

#[napi(object)]
pub struct NativeGlobOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub pattern: Option<String>,
    pub aborted: Option<bool>,
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
        let matcher = match compile_glob(pattern) {
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
        Ok(complete_glob(NativeSearchResult {
            kind: NativeToolOutcomeKind::Completed,
            total,
            lines: retained.into_iter().map(|entry| entry.path).collect(),
            output: None,
            error: None,
        }))
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
    use std::time::{Duration, SystemTime};

    use super::{GlobMatch, compare_glob};

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
}
