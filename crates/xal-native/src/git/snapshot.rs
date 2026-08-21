use super::*;

static INDEX_SUFFIX: AtomicU64 = AtomicU64::new(0);

fn temporary_index_directory() -> napi::Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = INDEX_SUFFIX.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let directory = std::env::temp_dir().join(format!(
        "xal-git-index-{}-{stamp}-{sequence}",
        std::process::id()
    ));
    fs::create_dir(&directory).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not create temporary Git index: {error}"),
        )
    })?;
    Ok(directory)
}

pub(super) fn capture_tree(workspace: &str, forced: &[String], full: bool) -> napi::Result<String> {
    validate_targets(Path::new(workspace), forced)?;
    let directory = temporary_index_directory()?;
    let index = directory.join("index");
    let index_text = index.to_string_lossy().into_owned();
    let result = (|| {
        let base_args = ["rev-parse", "--verify", "HEAD^{tree}"];
        let owned = base_args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let base = run_git(workspace, &owned, None, None, None)
            .map_err(|message| Error::new(Status::GenericFailure, message))?;
        if base.exit_code == 0 {
            let tree = output_text(&base, "git returned a non-UTF-8 object ID")?;
            checked_git(workspace, &["read-tree", &tree], Some(&index_text), None)?;
        } else {
            checked_git(
                workspace,
                &["read-tree", "--empty"],
                Some(&index_text),
                None,
            )?;
        }
        if full {
            let untracked = checked_git(
                workspace,
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                ],
                None,
                None,
            )?;
            let mut oversized = Vec::new();
            for path in nul_paths(&untracked.stdout)? {
                match fs::symlink_metadata(Path::new(workspace).join(&path)) {
                    Ok(metadata) if metadata.is_file() && metadata.len() > 2 * 1024 * 1024 => {
                        oversized.push(path);
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!("could not inspect untracked snapshot target {path}: {error}"),
                        ));
                    }
                }
            }
            checked_git(
                workspace,
                &["add", "-A", "--", "."],
                Some(&index_text),
                None,
            )?;
            for path in oversized {
                checked_git(
                    workspace,
                    &["update-index", "--force-remove", "--", &path],
                    Some(&index_text),
                    None,
                )?;
            }
        }
        for path in forced {
            match fs::symlink_metadata(Path::new(workspace).join(path)) {
                Ok(_) => {
                    checked_git(
                        workspace,
                        &["add", "-f", "-A", "--", path],
                        Some(&index_text),
                        None,
                    )?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !full => {
                    checked_git(
                        workspace,
                        &["update-index", "--force-remove", "--", path],
                        Some(&index_text),
                        None,
                    )?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!("could not inspect snapshot target {path}: {error}"),
                    ));
                }
            }
        }
        let output = checked_git(workspace, &["write-tree"], Some(&index_text), None)?;
        output_text(&output, "git returned a non-UTF-8 object ID")
    })();
    match (result, fs::remove_dir_all(&directory)) {
        (Ok(tree), Ok(())) => Ok(tree),
        (Ok(_), Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("could not remove temporary Git index: {error}"),
        )),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(Error::new(
            Status::GenericFailure,
            format!(
                "{}; could not remove temporary Git index: {cleanup}",
                error.reason
            ),
        )),
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeGitlink {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[napi(object)]
pub struct NativeGitSnapshot {
    pub before: String,
    pub after: String,
    pub paths: Vec<String>,
    pub index: Buffer,
    pub gitlinks: Vec<NativeGitlink>,
    pub forced: Vec<String>,
}

#[napi(object)]
pub struct NativeCaptureRequest {
    pub forced: Vec<String>,
    pub full: bool,
}

#[napi(object)]
pub struct NativeTreePairRequest {
    pub before: String,
    pub after: String,
}

#[napi(object)]
pub struct NativeGitlinksRequest {
    pub before: String,
    pub after: String,
    pub paths: Vec<String>,
}

#[napi(object)]
pub struct NativeApplySnapshotRequest {
    pub snapshot: NativeGitSnapshot,
    pub reverse: bool,
}

fn tree_entry(top: &str, tree: &str, path: &str) -> napi::Result<Option<(String, String)>> {
    let output = checked_git(top, &["ls-tree", "-z", tree, "--", path], None, None)?;
    if output.stdout.is_empty() {
        return Ok(None);
    }
    if output.stdout.last() != Some(&0) {
        return Err(Error::new(
            Status::GenericFailure,
            "git ls-tree returned a malformed entry".to_owned(),
        ));
    }
    let Some(tab) = output.stdout.iter().position(|byte| *byte == b'\t') else {
        return Err(Error::new(
            Status::GenericFailure,
            "git ls-tree returned a malformed entry".to_owned(),
        ));
    };
    let fields = utf8(
        &output.stdout[..tab],
        "git ls-tree returned a malformed entry",
    )?;
    let fields = fields.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 {
        return Err(Error::new(
            Status::GenericFailure,
            "git ls-tree returned a malformed entry".to_owned(),
        ));
    }
    Ok(Some((fields[0].to_owned(), fields[2].to_owned())))
}

pub(super) fn gitlinks(
    top: &str,
    request: &NativeGitlinksRequest,
) -> napi::Result<Vec<NativeGitlink>> {
    let mut links = Vec::new();
    for path in &request.paths {
        let before = tree_entry(top, &request.before, path)?;
        let after = tree_entry(top, &request.after, path)?;
        match (before, after) {
            (Some((before_mode, before_object)), Some((after_mode, after_object)))
                if before_mode == "160000" && after_mode == "160000" =>
            {
                links.push(NativeGitlink {
                    path: path.clone(),
                    before: before_object,
                    after: after_object,
                });
            }
            (Some((before_mode, _)), Some((after_mode, _)))
                if before_mode == "160000" || after_mode == "160000" =>
            {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("replaced submodule {path} cannot be snapshotted safely"),
                ));
            }
            (Some((mode, _)), None) | (None, Some((mode, _))) if mode == "160000" => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("added or removed submodule {path} cannot be snapshotted safely"),
                ));
            }
            _ => {}
        }
    }
    Ok(links)
}

pub(super) fn index_state(top: &str, paths: &[String]) -> napi::Result<Vec<u8>> {
    let mut args = vec!["ls-files", "--stage", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(checked_git(top, &args, None, None)?.stdout)
}

pub(super) fn head_state(top: &str) -> napi::Result<String> {
    let revision_args = ["rev-parse", "--verify", "-q", "HEAD"];
    let revision_owned = revision_args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let revision = run_git(top, &revision_owned, None, None, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if revision.exit_code != 0 && revision.exit_code != 1 {
        return Err(Error::new(
            Status::GenericFailure,
            git_failure(&revision_owned, &revision),
        ));
    }
    let reference_args = ["symbolic-ref", "-q", "HEAD"];
    let reference_owned = reference_args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let reference = run_git(top, &reference_owned, None, None, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if reference.exit_code != 0 && reference.exit_code != 1 {
        return Err(Error::new(
            Status::GenericFailure,
            git_failure(&reference_owned, &reference),
        ));
    }
    Ok(format!(
        "{}\0{}",
        if revision.exit_code == 0 {
            output_text(&revision, "git returned a non-UTF-8 object ID")?
        } else {
            String::new()
        },
        if reference.exit_code == 0 {
            output_text(&reference, "git returned a non-UTF-8 reference")?
        } else {
            String::new()
        }
    ))
}

fn apply_patch(top: &str, patch: &[u8], reverse: bool) -> napi::Result<()> {
    let mut args = vec!["apply"];
    if reverse {
        args.push("--reverse");
    }
    args.extend(["--binary", "--whitespace=nowarn"]);
    checked_git(top, &args, None, Some(patch))?;
    Ok(())
}

fn checkout_gitlink(top: &str, link: &NativeGitlink, revision: &str) -> napi::Result<()> {
    let path = Path::new(top).join(&link.path);
    checked_git(
        &path.to_string_lossy(),
        &["checkout", "--detach", "--quiet", revision],
        None,
        None,
    )?;
    Ok(())
}

fn preflight_gitlink(top: &str, link: &NativeGitlink, revision: &str) -> napi::Result<()> {
    let path = Path::new(top).join(&link.path);
    let cwd = path.to_string_lossy();
    let status = checked_git(
        &cwd,
        &["status", "--porcelain", "--untracked-files=all"],
        None,
        None,
    )?;
    if !status.stdout.is_empty() {
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "submodule {} has later worktree changes; they were left intact.",
                link.path
            ),
        ));
    }
    checked_git(
        &cwd,
        &["cat-file", "-e", &format!("{revision}^{{commit}}")],
        None,
        None,
    )?;
    Ok(())
}

pub(super) fn apply_snapshot(
    workspace: &str,
    request: &NativeApplySnapshotRequest,
) -> napi::Result<()> {
    let top = repository_root(workspace)?;
    let top = top.to_string_lossy();
    let snapshot = &request.snapshot;
    let current_index = index_state(&top, &snapshot.paths)?;
    if current_index != snapshot.index.as_ref() {
        let message = if request.reverse {
            "Git index entries for the last agent change were staged afterward; the index and worktree were left intact.".to_owned()
        } else {
            format!(
                "Git index entries were staged after undo for: {}. The index and worktree were left intact.",
                snapshot.paths.join(", ")
            )
        };
        return Err(Error::new(Status::GenericFailure, message));
    }
    let current = capture_tree(workspace, &snapshot.forced, true)?;
    let expected = if request.reverse {
        &snapshot.after
    } else {
        &snapshot.before
    };
    let mut verify = vec![
        "diff",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        expected,
        &current,
        "--",
    ];
    verify.extend(snapshot.paths.iter().map(String::as_str));
    let verify_owned = verify
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let verification = run_git(&top, &verify_owned, None, None, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if verification.exit_code == 1 {
        let message = if request.reverse {
            "files from the last agent change were edited afterward; those edits were left intact."
                .to_owned()
        } else {
            format!(
                "files were edited after undo: {}. Those edits were left intact.",
                snapshot.paths.join(", ")
            )
        };
        return Err(Error::new(Status::GenericFailure, message));
    }
    if verification.exit_code != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            git_failure(&verify_owned, &verification),
        ));
    }
    for link in &snapshot.gitlinks {
        preflight_gitlink(
            &top,
            link,
            if request.reverse {
                &link.before
            } else {
                &link.after
            },
        )?;
    }
    let regular = snapshot
        .paths
        .iter()
        .filter(|path| !snapshot.gitlinks.iter().any(|link| link.path == **path))
        .map(String::as_str)
        .collect::<Vec<_>>();
    let patch = if regular.is_empty() {
        Vec::new()
    } else {
        let mut args = vec![
            "diff",
            "--binary",
            "--full-index",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            &snapshot.before,
            &snapshot.after,
            "--",
        ];
        args.extend(regular);
        checked_git(&top, &args, None, None)?.stdout
    };
    if !patch.is_empty() {
        apply_patch(&top, &patch, request.reverse)?;
    }
    let mut changed: Vec<&NativeGitlink> = Vec::new();
    for link in &snapshot.gitlinks {
        let revision = if request.reverse {
            &link.before
        } else {
            &link.after
        };
        if let Err(error) = checkout_gitlink(&top, link, revision) {
            let mut rollback_failures = Vec::new();
            for completed in changed.iter().copied().chain(std::iter::once(link)).rev() {
                let rollback = if request.reverse {
                    &completed.after
                } else {
                    &completed.before
                };
                if let Err(rollback_error) = checkout_gitlink(&top, completed, rollback) {
                    rollback_failures.push(rollback_error.to_string());
                }
            }
            if !patch.is_empty()
                && let Err(rollback_error) = apply_patch(&top, &patch, !request.reverse)
            {
                rollback_failures.push(rollback_error.to_string());
            }
            if rollback_failures.is_empty() {
                return Err(error);
            }
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "{error}; restoring the pre-apply worktree also failed: {}",
                    rollback_failures.join("; ")
                ),
            ));
        }
        changed.push(link);
    }
    Ok(())
}
