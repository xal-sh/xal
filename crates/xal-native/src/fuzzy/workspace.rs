use super::*;

#[derive(Clone)]
struct WorkspaceEntry {
    path: String,
    fields: [PreparedField; 2],
}
#[napi(object)]
pub struct NativeWorkspaceSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub paths: Vec<String>,
}

fn workspace_entry(path: String) -> WorkspaceEntry {
    let basename = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&path)
        .to_owned();
    WorkspaceEntry {
        fields: [
            PreparedField {
                compact: compact(&path),
                weight: 1.0,
            },
            PreparedField {
                compact: compact(&basename),
                weight: 1.5,
            },
        ],
        path,
    }
}

fn compare_paths(left: &str, right: &str) -> std::cmp::Ordering {
    let left_lower = left.to_lowercase();
    let right_lower = right.to_lowercase();
    left_lower.cmp(&right_lower).then_with(|| {
        for (left, right) in left.chars().zip(right.chars()) {
            if left == right {
                continue;
            }
            if left.to_lowercase().eq(right.to_lowercase()) {
                return left.is_uppercase().cmp(&right.is_uppercase());
            }
            return left.cmp(&right);
        }
        left.len().cmp(&right.len())
    })
}

fn rank_workspace(
    query: &str,
    entries: &[WorkspaceEntry],
    limit: usize,
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<String>> {
    let query_terms = terms(query);
    let mut matches = Vec::<(f64, String)>::new();
    for entry in entries {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Relaxed)) {
            return None;
        }
        let Some(score) = score_terms(&query_terms, &entry.fields) else {
            continue;
        };
        let position = matches.partition_point(|(existing_score, existing_path)| {
            *existing_score > score
                || (*existing_score == score && compare_paths(existing_path, &entry.path).is_lt())
        });
        if position < limit {
            matches.insert(position, (score, entry.path.clone()));
            matches.truncate(limit);
        }
    }
    Some(matches.into_iter().map(|(_, path)| path).collect())
}

#[napi]
pub struct NativePathRanker {
    entries: Vec<WorkspaceEntry>,
}

#[napi]
impl NativePathRanker {
    #[napi(constructor, catch_unwind)]
    pub fn new(paths: Vec<String>) -> Self {
        Self {
            entries: paths.into_iter().map(workspace_entry).collect(),
        }
    }

    #[napi(catch_unwind)]
    pub fn rank(&self, query: String, limit: u32) -> Vec<String> {
        rank_workspace(&query, &self.entries, limit as usize, None).unwrap_or_default()
    }
}

#[napi]
pub struct NativeWorkspaceIndex {
    entries: Arc<Vec<WorkspaceEntry>>,
}

pub struct WorkspaceIndexTask {
    cwd: PathBuf,
    values: Vec<String>,
    marker: String,
    cancelled: Arc<AtomicBool>,
}

impl Task for WorkspaceIndexTask {
    type Output = NativeWorkspaceIndex;
    type JsValue = NativeWorkspaceIndex;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let matcher = if self.values.is_empty() {
            None
        } else {
            Some(
                SecretMatcher::new(
                    self.values
                        .iter()
                        .map(|value| value.encode_utf16().collect())
                        .collect(),
                    self.marker.encode_utf16().collect(),
                )
                .map_err(|reason| Error::new(Status::InvalidArg, reason))?,
            )
        };
        let files = walk_files(&self.cwd, &self.cancelled, None)?;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(
                Status::Cancelled,
                "native operation interrupted",
            ));
        }
        let mut directories = HashSet::new();
        let mut paths = Vec::new();
        for file in files {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    Status::Cancelled,
                    "native operation interrupted",
                ));
            }
            let Ok(relative) = file.strip_prefix(&self.cwd) else {
                continue;
            };
            let path = relative.to_string_lossy().into_owned();
            if path.contains(['\r', '\n', '"']) || redacts(&matcher, &path) {
                continue;
            }
            let mut directory = relative.parent();
            while let Some(value) = directory {
                if value.as_os_str().is_empty() {
                    break;
                }
                let path = format!("{}{}", value.to_string_lossy(), MAIN_SEPARATOR);
                if !path.contains(['\r', '\n', '"']) && !redacts(&matcher, &path) {
                    directories.insert(path);
                }
                directory = value.parent();
            }
            paths.push(path);
        }
        paths.extend(directories);
        let entries = paths.into_iter().map(workspace_entry).collect();
        Ok(NativeWorkspaceIndex {
            entries: Arc::new(entries),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

fn redacts(matcher: &Option<SecretMatcher>, text: &str) -> bool {
    let Some(matcher) = matcher else {
        return false;
    };
    let units = text.encode_utf16().collect::<Vec<_>>();
    matcher.redact(&units) != units
}

#[napi(js_name = "createWorkspaceIndex", catch_unwind)]
pub fn create_workspace_index(
    cwd: String,
    values: Vec<String>,
    marker: String,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorkspaceIndexTask> {
    AsyncTask::new(WorkspaceIndexTask {
        cwd: PathBuf::from(cwd),
        values,
        marker,
        cancelled: cancellation_flag(signal),
    })
}

pub struct WorkspaceSearchTask {
    entries: Arc<Vec<WorkspaceEntry>>,
    query: String,
    cancelled: Arc<AtomicBool>,
}

impl Task for WorkspaceSearchTask {
    type Output = NativeWorkspaceSearchResult;
    type JsValue = NativeWorkspaceSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let Some(paths) = rank_workspace(
            &self.query,
            &self.entries,
            WORKSPACE_RESULT_LIMIT,
            Some(&self.cancelled),
        ) else {
            return Ok(NativeWorkspaceSearchResult {
                kind: NativeToolOutcomeKind::Interrupted,
                paths: Vec::new(),
            });
        };
        Ok(NativeWorkspaceSearchResult {
            kind: NativeToolOutcomeKind::Completed,
            paths,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl NativeWorkspaceIndex {
    #[napi(catch_unwind)]
    pub fn search(
        &self,
        query: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<WorkspaceSearchTask> {
        AsyncTask::new(WorkspaceSearchTask {
            entries: self.entries.clone(),
            query,
            cancelled: cancellation_flag(signal),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::compare_paths;

    #[test]
    fn workspace_path_order_is_deterministic() {
        assert!(compare_paths("apps", "Cargo").is_lt());
        assert!(compare_paths("a", "A").is_lt());
    }
}
