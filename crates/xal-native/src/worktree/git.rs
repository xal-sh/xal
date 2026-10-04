use super::*;

pub(super) fn checked_git(
    cwd: &Path,
    args: &[&str],
    cancelled: &AtomicBool,
) -> napi::Result<String> {
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(failed("Worktree operation interrupted"));
    }
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output =
        run_git(&cwd.to_string_lossy(), &args, None, None, Some(cancelled)).map_err(failed)?;
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(failed("Worktree operation interrupted"));
    }
    if output.exit_code == 0 {
        return Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned());
    }
    let detail = String::from_utf8_lossy(&output.stderr)
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    Err(failed(if detail.is_empty() {
        format!(
            "git {} failed with exit code {}",
            args.first().map_or("command", String::as_str),
            output.exit_code
        )
    } else {
        format!(
            "git {} failed: {detail}",
            args.first().map_or("command", String::as_str)
        )
    }))
}

pub(super) fn cleanup_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(&cwd.to_string_lossy(), &args, None, None, None)?;
    if output.exit_code == 0 {
        return Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned());
    }
    let detail = String::from_utf8_lossy(&output.stderr)
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    Err(if detail.is_empty() {
        format!(
            "git {} failed with exit code {}",
            args.first().map_or("command", String::as_str),
            output.exit_code
        )
    } else {
        detail
    })
}

pub(super) fn rollback_created(repository_root: &Path, path: &Path, branch: &str) -> Vec<String> {
    let mut failures = Vec::new();
    let path_text = path.to_string_lossy();
    let registered = cleanup_git(repository_root, &["worktree", "list", "--porcelain"]).map_or(
        true,
        |listing| {
            listing
                .lines()
                .any(|line| line.strip_prefix("worktree ") == Some(path_text.as_ref()))
        },
    );
    if registered
        && let Err(error) = cleanup_git(
            repository_root,
            &["worktree", "remove", "--force", &path_text],
        )
    {
        failures.push(error);
    }
    if path.exists()
        && let Err(error) = fs::remove_dir_all(path)
    {
        failures.push(error.to_string());
    }
    let reference = format!("refs/heads/{branch}");
    if cleanup_git(
        repository_root,
        &["show-ref", "--verify", "--quiet", &reference],
    )
    .is_ok()
        && let Err(error) = cleanup_git(repository_root, &["branch", "-D", branch])
    {
        failures.push(error);
    }
    failures
}

pub(super) fn rollback_error(error: Error, failures: Vec<String>) -> Error {
    if failures.is_empty() {
        return error;
    }
    failed(format!("{error}; rollback failed: {}", failures.join("; ")))
}
