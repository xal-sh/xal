use super::*;

#[derive(Clone)]
struct WorkspaceEntry {
    path: String,
    fields: [PreparedField; 2],
}
pub struct WorkspaceSearchResult {
    pub kind: ToolOutcomeKind,
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
    cancelled: &AtomicBool,
) -> Option<Vec<String>> {
    let query_terms = terms(query);
    let mut matches = Vec::<(f64, String)>::new();
    for entry in entries {
        if cancelled.load(Ordering::Relaxed) {
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

pub struct WorkspaceIndex {
    entries: Arc<Vec<WorkspaceEntry>>,
}

pub struct WorkspaceIndexTask {
    cwd: PathBuf,
    values: Vec<String>,
    marker: String,
    cancelled: Arc<AtomicBool>,
}

impl WorkspaceIndexTask {
    pub fn compute(&mut self) -> io::Result<WorkspaceIndex> {
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
                .map_err(|reason| Error::new(io::ErrorKind::InvalidInput, reason))?,
            )
        };
        let files = walk_files(&self.cwd, &self.cancelled, None)?;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(
                io::ErrorKind::Interrupted,
                "native operation interrupted",
            ));
        }
        let mut directories = HashSet::new();
        let mut paths = Vec::new();
        for file in files {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    io::ErrorKind::Interrupted,
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
        Ok(WorkspaceIndex {
            entries: Arc::new(entries),
        })
    }
}

fn redacts(matcher: &Option<SecretMatcher>, text: &str) -> bool {
    let Some(matcher) = matcher else {
        return false;
    };
    let units = text.encode_utf16().collect::<Vec<_>>();
    matcher.redact(&units) != units
}

pub fn create_workspace_index(
    cwd: String,
    values: Vec<String>,
    marker: String,
    cancelled: Arc<AtomicBool>,
) -> WorkspaceIndexTask {
    WorkspaceIndexTask {
        cwd: PathBuf::from(cwd),
        values,
        marker,
        cancelled,
    }
}

pub struct WorkspaceSearchTask {
    entries: Arc<Vec<WorkspaceEntry>>,
    query: String,
    cancelled: Arc<AtomicBool>,
}

impl WorkspaceSearchTask {
    pub fn compute(&mut self) -> io::Result<WorkspaceSearchResult> {
        let Some(paths) = rank_workspace(
            &self.query,
            &self.entries,
            WORKSPACE_RESULT_LIMIT,
            &self.cancelled,
        ) else {
            return Ok(WorkspaceSearchResult {
                kind: ToolOutcomeKind::Interrupted,
                paths: Vec::new(),
            });
        };
        Ok(WorkspaceSearchResult {
            kind: ToolOutcomeKind::Completed,
            paths,
        })
    }
}

impl WorkspaceIndex {
    pub fn retain(&mut self, mut accept: impl FnMut(&str) -> bool) {
        Arc::make_mut(&mut self.entries).retain(|entry| accept(&entry.path));
    }

    pub fn search(&self, query: String, cancelled: Arc<AtomicBool>) -> WorkspaceSearchTask {
        WorkspaceSearchTask {
            entries: self.entries.clone(),
            query,
            cancelled,
        }
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
