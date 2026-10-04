use super::git::checked_git;
use super::*;

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

pub(super) fn write_new_secure(path: &Path, text: &str) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failed("managed worktree marker path is invalid"))?;
    let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", suffix()));
    let result = (|| {
        let mut file = crate::storage::create_secure(&temporary)?;
        file.write_all(text.as_bytes())
            .map_err(|error| failed(error.to_string()))?;
        file.sync_all().map_err(|error| failed(error.to_string()))?;
        fs::hard_link(&temporary, path).map_err(|error| failed(error.to_string()))?;
        Ok(())
    })();
    match fs::remove_file(&temporary) {
        Ok(()) => result,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => result,
        Err(error) => Err(failed(match result {
            Ok(()) => format!("temporary marker cleanup failed: {error}"),
            Err(original) => format!("{original}; temporary marker cleanup failed: {error}"),
        })),
    }
}

pub(super) fn marker_json(worktree: &ManagedWorktree) -> std::io::Result<String> {
    serde_json::to_string_pretty(worktree)
        .map(|text| format!("{text}\n"))
        .map_err(|error| failed(error.to_string()))
}

pub(super) fn parse_marker(text: &str) -> Option<ManagedWorktree> {
    let record = serde_json::from_str::<ManagedWorktree>(text).ok()?;
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
    Some(record)
}

pub(super) fn validate_marker_name(name: &str) -> std::io::Result<()> {
    if name.is_empty()
        || Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(failed("managed worktree marker name must be a file name"));
    }
    Ok(())
}

pub(super) fn marker_path(
    cwd: &Path,
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<PathBuf> {
    validate_marker_name(&request.marker_name)?;
    let git_dir = checked_git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-dir"],
        cancelled,
    )?;
    Ok(PathBuf::from(git_dir).join(&request.marker_name))
}

pub fn lookup(
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<Option<ManagedWorktree>> {
    if cancelled() {
        return Err(interrupted("Git command interrupted"));
    }
    let cwd = PathBuf::from(&request.cwd);
    let marker = marker_path(&cwd, request, cancelled)?;
    let Some(text) = crate::storage::read_text(&marker)? else {
        return Ok(None);
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
    if canonical(&parsed.repository_root)? != super::git::primary_worktree(&cwd, cancelled)? {
        return Err(failed(
            "managed worktree repository root is not the primary checkout",
        ));
    }
    let managed_cwd = canonical(&parsed.cwd)?;
    if !managed_cwd.starts_with(&recorded) {
        return Err(failed("managed worktree cwd is outside its checkout"));
    }
    let original = canonical(&parsed.original_cwd)?;
    let original_common = canonical(checked_git(
        &original,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cancelled,
    )?)?;
    if original_common != current_common || original.starts_with(&recorded) {
        return Err(failed(
            "managed worktree original cwd does not belong to its source repository",
        ));
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::{ManagedWorktree, marker_json, parse_marker};

    fn worktree() -> ManagedWorktree {
        let root = std::env::temp_dir().join("xal-marker-fixture");
        ManagedWorktree {
            version: 1,
            repository_root: root.join("repo\"root").to_str().unwrap().to_owned(),
            original_cwd: root.join("repo/root").to_str().unwrap().to_owned(),
            path: root.join("worktree").to_str().unwrap().to_owned(),
            cwd: root.join("worktree/nested").to_str().unwrap().to_owned(),
            branch: "xal/branch".to_owned(),
            base_commit: "abcdef".to_owned(),
        }
    }

    #[test]
    fn marker_round_trips_paths_and_escapes() {
        let worktree = worktree();
        let text = marker_json(&worktree).expect("marker should serialize");
        let parsed = parse_marker(&text).expect("marker should parse");
        assert_eq!(parsed.repository_root, worktree.repository_root);
        assert_eq!(parsed.cwd, worktree.cwd);
        assert_eq!(parsed.branch, worktree.branch);
    }

    #[test]
    fn marker_accepts_surrogate_pairs_and_distinguishes_json_syntax() {
        let mut worktree = worktree();
        worktree.branch = "😀".to_owned();
        let text = marker_json(&worktree)
            .unwrap()
            .replace("😀", r"\uD83D\uDE00");
        assert_eq!(
            parse_marker(&text).expect("marker should parse").branch,
            "😀"
        );
        assert!(parse_marker(&text.replace("\"baseCommit\"", "\"unknown\"")).is_none());
        assert!(
            parse_marker(&text.replace("\"version\": 1", "\"version\": 1,\"version\": 1"))
                .is_none()
        );
    }
}
