use super::git::checked_git;
use super::*;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkerRecord {
    version: u32,
    repository_root: String,
    original_cwd: String,
    path: String,
    cwd: String,
    branch: String,
    base_commit: String,
}

impl From<&NativeManagedWorktree> for MarkerRecord {
    fn from(worktree: &NativeManagedWorktree) -> Self {
        Self {
            version: worktree.version,
            repository_root: worktree.repository_root.clone(),
            original_cwd: worktree.original_cwd.clone(),
            path: worktree.path.clone(),
            cwd: worktree.cwd.clone(),
            branch: worktree.branch.clone(),
            base_commit: worktree.base_commit.clone(),
        }
    }
}

impl From<MarkerRecord> for NativeManagedWorktree {
    fn from(record: MarkerRecord) -> Self {
        Self {
            version: record.version,
            repository_root: record.repository_root,
            original_cwd: record.original_cwd,
            path: record.path,
            cwd: record.cwd,
            branch: record.branch,
            base_commit: record.base_commit,
        }
    }
}
pub(super) fn suffix() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{time:024x}{:08x}{count:08x}", std::process::id())
}

pub(super) fn repository_key(path: &Path) -> String {
    #[cfg(not(any(unix, windows)))]
    compile_error!("repository_key requires unix or windows path encoding");
    let mut hasher = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in path.as_os_str().encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
    }
    hasher.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn write_new_secure(path: &Path, text: &str) -> napi::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failed("managed worktree marker path is invalid"))?;
    let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", suffix()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| failed(error.to_string()))?;
        file.write_all(text.as_bytes())
            .map_err(|error| failed(error.to_string()))?;
        file.sync_all().map_err(|error| failed(error.to_string()))?;
        fs::hard_link(&temporary, path).map_err(|error| failed(error.to_string()))?;
        Ok(())
    })();
    let cleanup = fs::remove_file(&temporary);
    if let Err(error) = cleanup
        && result.is_ok()
    {
        return Err(failed(error.to_string()));
    }
    result
}

pub(super) fn marker_json(worktree: &NativeManagedWorktree) -> napi::Result<String> {
    serde_json::to_string_pretty(&MarkerRecord::from(worktree))
        .map(|text| format!("{text}\n"))
        .map_err(|error| failed(error.to_string()))
}

pub(super) fn parse_marker(text: &str) -> Option<NativeManagedWorktree> {
    let record = serde_json::from_str::<MarkerRecord>(text).ok()?;
    if record.version != 1
        || ![
            &record.repository_root,
            &record.original_cwd,
            &record.path,
            &record.cwd,
        ]
        .iter()
        .all(|value| Path::new(value).is_absolute())
    {
        return None;
    }
    Some(record.into())
}

pub(super) fn marker_path(
    cwd: &Path,
    request: &NativeWorktreeRequest,
    cancelled: &AtomicBool,
) -> napi::Result<PathBuf> {
    let git_dir = checked_git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-dir"],
        cancelled,
    )?;
    Ok(PathBuf::from(git_dir).join(&request.marker_name))
}

pub(super) fn lookup(
    request: &NativeWorktreeRequest,
    cancelled: &AtomicBool,
) -> napi::Result<Option<NativeManagedWorktree>> {
    let cwd = PathBuf::from(&request.cwd);
    let marker = marker_path(&cwd, request, cancelled)?;
    let text = match fs::read_to_string(&marker) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed(error.to_string())),
    };
    if serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err(failed(format!(
            "{} is malformed — fix or delete it",
            marker.display()
        )));
    }
    let parsed = parse_marker(&text).ok_or_else(|| {
        failed(format!(
            "{} has an invalid managed worktree record",
            marker.display()
        ))
    })?;
    let root = canonical(checked_git(
        &cwd,
        &["rev-parse", "--show-toplevel"],
        cancelled,
    )?)?;
    let recorded = canonical(&parsed.path)?;
    if root != recorded {
        return Err(failed(format!(
            "managed worktree marker does not match {}",
            root.display()
        )));
    }
    let worktrees_dir = canonical(&request.worktrees_dir)?;
    if !recorded.starts_with(&worktrees_dir) {
        return Err(failed(format!(
            "managed worktree is outside {}",
            request.worktrees_dir
        )));
    }
    let current_common = canonical(checked_git(
        &cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cancelled,
    )?)?;
    let recorded_common = canonical(checked_git(
        Path::new(&parsed.repository_root),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cancelled,
    )?)?;
    if current_common != recorded_common {
        return Err(failed(format!(
            "managed worktree repository does not match {}",
            root.display()
        )));
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::{NativeManagedWorktree, marker_json, parse_marker};

    #[test]
    fn marker_round_trips_paths_and_escapes() {
        let worktree = NativeManagedWorktree {
            version: 1,
            repository_root: "/repo\"root".to_owned(),
            original_cwd: "/repo/root".to_owned(),
            path: "/tmp/worktree".to_owned(),
            cwd: "/tmp/worktree/nested".to_owned(),
            branch: "xal/branch".to_owned(),
            base_commit: "abcdef".to_owned(),
        };
        let text = marker_json(&worktree).expect("marker should serialize");
        let parsed = parse_marker(&text).expect("marker should parse");
        assert_eq!(parsed.repository_root, worktree.repository_root);
        assert_eq!(parsed.cwd, worktree.cwd);
        assert_eq!(parsed.branch, worktree.branch);
    }

    #[test]
    fn marker_accepts_surrogate_pairs_and_distinguishes_json_syntax() {
        let text = "{\"version\":1,\"repositoryRoot\":\"/repo\",\"originalCwd\":\"/repo\",\"path\":\"/tmp/worktree\",\"cwd\":\"/tmp/worktree\",\"branch\":\"\\uD83D\\uDE00\",\"baseCommit\":\"abcdef\"}";
        assert_eq!(
            parse_marker(text).expect("marker should parse").branch,
            "😀"
        );
        assert!(parse_marker(&text.replace("\"baseCommit\"", "\"unknown\"")).is_none());
        assert!(
            parse_marker(&text.replace("\"version\":1", "\"version\":1,\"version\":1")).is_none()
        );
    }
}
