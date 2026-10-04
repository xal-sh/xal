use super::git::{checked_git, primary_worktree, rollback_created, rollback_error};
use super::marker::{lookup, marker_json, marker_path, repository_key, suffix, write_new_secure};
use super::*;

static MUTATION: OnceLock<Mutex<()>> = OnceLock::new();
fn mutation(cancelled: &dyn Fn() -> bool) -> std::io::Result<MutexGuard<'static, ()>> {
    loop {
        if cancelled() {
            return Err(interrupted("Worktree operation interrupted"));
        }
        match MUTATION.get_or_init(|| Mutex::new(())).try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(failed("worktree mutation lock poisoned"));
            }
        }
    }
}

fn slug(name: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in name.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !output.is_empty() && output.len() < 48 {
                output.push('-');
            }
            separator = false;
            if output.len() < 48 {
                output.push(character);
            }
        } else {
            separator = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    output
}
pub fn create_managed_worktree(
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<ManagedWorktree> {
    if cancelled() {
        return Err(interrupted("Worktree creation interrupted"));
    }
    let _guard = mutation(cancelled)?;
    super::marker::validate_marker_name(&request.marker_name)?;
    let cwd = PathBuf::from(&request.cwd);
    let current_root = canonical(checked_git(
        &cwd,
        &["rev-parse", "--show-toplevel"],
        cancelled,
    )?)?;
    let repository_root = primary_worktree(&cwd, cancelled)?;
    let original_cwd = canonical(&cwd)?;
    let relative_cwd = original_cwd.strip_prefix(&current_root).map_err(|_| {
        failed(format!(
            "{} is outside the Git worktree at {}",
            original_cwd.display(),
            current_root.display()
        ))
    })?;
    let status = checked_git(
        &original_cwd,
        &["status", "--porcelain", "--untracked-files=all"],
        cancelled,
    )?;
    if !status.is_empty() {
        return Err(failed(
            "workspace has uncommitted changes; commit or stash them before creating an isolated worktree",
        ));
    }
    let base_commit = checked_git(
        &original_cwd,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        cancelled,
    )?;
    let suffix = suffix();
    let label = request
        .name
        .as_deref()
        .map(slug)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "workspace".to_owned());
    let branch = format!("{}/{label}-{suffix}", request.app_name);
    fs::create_dir_all(&request.worktrees_dir)?;
    let worktrees_dir = canonical(&request.worktrees_dir)?;
    let path = worktrees_dir
        .join(repository_key(&repository_root))
        .join(format!("{label}-{suffix}"));
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| failed("worktree parent is unavailable"))?,
    )
    .map_err(|error| failed(error.to_string()))?;
    if cancelled() {
        return Err(interrupted("Worktree creation interrupted"));
    }
    let parent = canonical(
        path.parent()
            .ok_or_else(|| failed("worktree parent is unavailable"))?,
    )?;
    if !parent.starts_with(&worktrees_dir) {
        return Err(failed(
            "worktree parent is outside the managed worktrees directory",
        ));
    }
    let worktree = ManagedWorktree {
        version: 1,
        repository_root: path_text(&repository_root)?,
        original_cwd: path_text(&original_cwd)?,
        path: path_text(&path)?,
        cwd: path_text(&path.join(relative_cwd))?,
        branch: branch.clone(),
        base_commit: base_commit.clone(),
    };
    let path_argument = crate::git::path_argument(&path)?;
    fs::create_dir(&path)?;
    if let Err(error) = checked_git(
        &repository_root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path_argument,
            &base_commit,
        ],
        cancelled,
    ) {
        return Err(rollback_error(
            error,
            rollback_created(&repository_root, &path, &branch, &base_commit),
        ));
    }
    let result = (|| {
        if !Path::new(&worktree.cwd).exists() {
            return Err(failed(format!(
                "worktree checkout is missing {}",
                worktree.cwd
            )));
        }
        let marker = marker_path(&path, request, cancelled)?;
        write_new_secure(&marker, &marker_json(&worktree)?)?;
        if cancelled() {
            return Err(interrupted("Worktree creation interrupted"));
        }
        Ok(())
    })();
    if let Err(error) = result {
        return Err(rollback_error(
            error,
            rollback_created(&repository_root, &path, &branch, &base_commit),
        ));
    }
    Ok(worktree)
}

fn require_current(
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<ManagedWorktree> {
    let expected = request
        .worktree
        .as_ref()
        .ok_or_else(|| failed("managed worktree record is required"))?;
    let lookup_request = WorktreeRequest {
        cwd: expected.path.clone(),
        worktrees_dir: request.worktrees_dir.clone(),
        app_name: request.app_name.clone(),
        display_name: request.display_name.clone(),
        marker_name: request.marker_name.clone(),
        name: None,
        worktree: None,
        force: None,
    };
    let current = lookup(&lookup_request, cancelled)?;
    match current {
        Some(current) if &current == expected => Ok(current),
        _ => Err(failed(format!(
            "{} is not a managed {} worktree",
            expected.path, request.display_name
        ))),
    }
}

pub fn remove_managed_worktree(
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<()> {
    if cancelled() {
        return Err(interrupted("Worktree removal interrupted"));
    }
    let _guard = mutation(cancelled)?;
    let current = require_current(request, cancelled)?;
    if !request.force.unwrap_or(false) {
        let status = checked_git(
            Path::new(&current.path),
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
            ],
            cancelled,
        )?;
        if !status.is_empty() {
            return Err(failed(
                "worktree has uncommitted or ignored files; preserve them or retry with force to discard them",
            ));
        }
    }
    if cancelled() {
        return Err(interrupted("Worktree removal interrupted"));
    }
    let mut args = vec!["worktree", "remove"];
    if request.force.unwrap_or(false) {
        args.push("--force");
    }
    let path_argument = crate::git::path_argument(Path::new(&current.path))?;
    args.push(&path_argument);
    checked_git(Path::new(&current.repository_root), &args, cancelled)?;
    Ok(())
}

pub fn unmanage_worktree(
    request: &WorktreeRequest,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<()> {
    if cancelled() {
        return Err(interrupted("Git command interrupted"));
    }
    let _guard = mutation(cancelled)?;
    let current = require_current(request, cancelled)?;
    let marker = marker_path(Path::new(&current.path), request, cancelled)?;
    if cancelled() {
        return Err(interrupted("Git command interrupted"));
    }
    fs::remove_file(marker)?;
    Ok(())
}
