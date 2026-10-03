use super::*;

pub(super) fn checked_git(
    cwd: &Path,
    args: &[&str],
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<String> {
    if cancelled() {
        return Err(interrupted("Worktree operation interrupted"));
    }
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(&path_text(cwd)?, &args, None, None, Some(cancelled))?;
    if output.interrupted || cancelled() {
        return Err(interrupted("Worktree operation interrupted"));
    }
    if output.exit_code == 0 {
        return String::from_utf8(output.stdout)
            .map(|text| text.trim_end_matches(['\r', '\n']).to_owned())
            .map_err(|error| failed(format!("Git returned non-UTF-8 output: {error}")));
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
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

pub(super) fn primary_worktree(
    cwd: &Path,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<PathBuf> {
    let listing = checked_git(cwd, &["worktree", "list", "--porcelain", "-z"], cancelled)?;
    let primary = listing
        .split('\0')
        .find_map(|entry| entry.strip_prefix("worktree "))
        .ok_or_else(|| failed("Git did not report a primary worktree"))?;
    canonical(primary)
}

pub(super) fn rollback_created(
    repository_root: &Path,
    path: &Path,
    branch: &str,
    base: &str,
) -> Vec<String> {
    let result = (|| {
        let path_text = crate::git::path_argument(path)?;
        let listing = checked_git(
            repository_root,
            &["worktree", "list", "--porcelain", "-z"],
            &|| false,
        )?;
        let registered = listing
            .split('\0')
            .filter_map(|entry| entry.strip_prefix("worktree "))
            .any(|entry| Path::new(entry) == Path::new(&path_text));
        if registered {
            let head = checked_git(path, &["rev-parse", "HEAD"], &|| false)?;
            let status = checked_git(
                path,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--ignored",
                ],
                &|| false,
            )?;
            if head != base || !status.is_empty() {
                return Err(failed(format!(
                    "{} has new work; checkout and branch were preserved",
                    path.display()
                )));
            }
            checked_git(
                repository_root,
                &["worktree", "remove", &path_text],
                &|| false,
            )?;
        } else {
            match fs::remove_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(failed(format!(
                        "could not remove empty checkout {}: {error}; branch was preserved",
                        path.display()
                    )));
                }
            }
        }
        let reference = format!("refs/heads/{branch}");
        let args = ["show-ref", "--verify", "--quiet", &reference].map(str::to_owned);
        let output = run_git(&super::path_text(repository_root)?, &args, None, None, None)?;
        match output.exit_code {
            0 => {
                checked_git(
                    repository_root,
                    &["update-ref", "-d", &reference, base],
                    &|| false,
                )?;
            }
            1 => {}
            _ => {
                return Err(failed(format!(
                    "could not inspect created branch: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => Vec::new(),
        Err(error) => vec![error.to_string()],
    }
}

pub(super) fn rollback_error(error: Error, failures: Vec<String>) -> Error {
    if failures.is_empty() {
        return error;
    }
    failed(format!("{error}; rollback failed: {}", failures.join("; ")))
}
