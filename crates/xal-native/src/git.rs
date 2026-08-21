#![cfg_attr(test, allow(dead_code))]

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::tool_contracts::cancellation_flag;

#[napi(object)]
pub struct NativeGitCommandRequest {
    pub args: Vec<String>,
    pub index_file: Option<String>,
    pub input: Option<Buffer>,
}

#[napi(object)]
pub struct NativeGitCommandOutput {
    pub stdout: Buffer,
    pub stderr: Buffer,
    pub exit_code: i32,
    pub interrupted: bool,
}

pub(crate) struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

pub(crate) fn run_git(
    cwd: &str,
    args: &[String],
    index_file: Option<&str>,
    input: Option<&[u8]>,
    cancelled: Option<&AtomicBool>,
) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .arg("--literal-pathspecs")
        .args(["-c", "core.autocrlf=false"])
        .args(["-c", "core.longpaths=true"])
        .args(["-c", "core.symlinks=true"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run git: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "git stdin was unavailable".to_owned())?;
    let input = input.map(<[u8]>::to_vec).unwrap_or_default();
    let input_thread = thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout was unavailable".to_owned())?;
    let stdout_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr was unavailable".to_owned())?;
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let (status, interrupted) = loop {
        if cancelled.is_some_and(|cancelled| cancelled.load(std::sync::atomic::Ordering::Relaxed)) {
            let _ = child.kill();
            break (
                child
                    .wait()
                    .map_err(|error| format!("could not wait for git: {error}"))?,
                true,
            );
        }
        match child
            .try_wait()
            .map_err(|error| format!("could not wait for git: {error}"))?
        {
            Some(status) => break (status, false),
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    let input_result = input_thread
        .join()
        .map_err(|_| "git input thread panicked".to_owned())?;
    if let Err(error) = input_result
        && error.kind() != std::io::ErrorKind::BrokenPipe
    {
        return Err(format!("could not send input to git: {error}"));
    }
    let stdout = stdout_thread
        .join()
        .map_err(|_| "git output thread panicked".to_owned())?
        .map_err(|error| format!("could not read git output: {error}"))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "git error thread panicked".to_owned())?
        .map_err(|error| format!("could not read git error output: {error}"))?;
    Ok(GitOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(if interrupted { 130 } else { 1 }),
    })
}

fn git_failure(args: &[String], output: &GitOutput) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if detail.is_empty() {
        return format!(
            "git {} exited with code {}",
            args.first().map_or("command", String::as_str),
            output.exit_code
        );
    }
    detail
}

fn checked_git(
    cwd: &str,
    args: &[&str],
    index_file: Option<&str>,
    input: Option<&[u8]>,
) -> napi::Result<GitOutput> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(cwd, &args, index_file, input, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if output.exit_code != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            git_failure(&args, &output),
        ));
    }
    Ok(output)
}

fn utf8(bytes: &[u8], message: &str) -> napi::Result<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|error| Error::new(Status::GenericFailure, format!("{message}: {error}")))
}

fn output_text(output: &GitOutput, message: &str) -> napi::Result<String> {
    Ok(utf8(&output.stdout, message)?.trim_end().to_owned())
}

fn nul_paths(bytes: &[u8]) -> napi::Result<Vec<String>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.last() != Some(&0) {
        return Err(Error::new(
            Status::GenericFailure,
            "git returned a malformed path list".to_owned(),
        ));
    }
    bytes[..bytes.len() - 1]
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| utf8(path, "git returned a non-UTF-8 path"))
        .collect()
}

fn repository_root(workspace: &str) -> napi::Result<PathBuf> {
    let args = ["rev-parse", "--show-toplevel"];
    let owned = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(workspace, &owned, None, None, None)
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if output.exit_code != 0 {
        return Err(Error::new(
            Status::GenericFailure,
            "the workspace is not a Git repository".to_owned(),
        ));
    }
    let reported = output_text(&output, "git returned a non-UTF-8 repository path")?;
    let top = fs::canonicalize(&reported).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not resolve the Git repository: {error}"),
        )
    })?;
    let workspace = canonical_target(Path::new(workspace))?;
    if !workspace.starts_with(&top) {
        return Err(Error::new(
            Status::GenericFailure,
            "Git reported a repository outside the workspace path".to_owned(),
        ));
    }
    Ok(top)
}

fn canonical_target(path: &Path) -> napi::Result<PathBuf> {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(base) => {
                let mut target = base;
                for part in suffix.iter().rev() {
                    target.push(part);
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = current.file_name() else {
                    return Ok(path.to_path_buf());
                };
                suffix.push(name.to_os_string());
                let Some(parent) = current.parent() else {
                    return Ok(path.to_path_buf());
                };
                current = parent.to_path_buf();
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("could not resolve snapshot target: {error}"),
                ));
            }
        }
    }
}

fn validate_targets(workspace: &Path, forced: &[String]) -> napi::Result<()> {
    let canonical_workspace = fs::canonicalize(workspace).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("could not resolve workspace: {error}"),
        )
    })?;
    for path in forced {
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(Error::new(
                Status::InvalidArg,
                format!("snapshot target is outside the workspace: {path}"),
            ));
        }
        let target = canonical_target(&workspace.join(relative))?;
        if !target.starts_with(&canonical_workspace) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("snapshot target is outside the workspace: {path}"),
            ));
        }
    }
    Ok(())
}

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

fn capture_tree(workspace: &str, forced: &[String], full: bool) -> napi::Result<String> {
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

#[napi(object)]
pub struct NativeRepositoryOutput {
    pub kind: String,
    pub ready: Option<bool>,
    pub root: Option<String>,
    pub reason: Option<String>,
    pub tree: Option<String>,
    pub paths: Option<Vec<String>>,
    pub bytes: Option<Buffer>,
    pub text: Option<String>,
    pub gitlinks: Option<Vec<NativeGitlink>>,
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

fn gitlinks(top: &str, request: &NativeGitlinksRequest) -> napi::Result<Vec<NativeGitlink>> {
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

fn index_state(top: &str, paths: &[String]) -> napi::Result<Vec<u8>> {
    let mut args = vec!["ls-files", "--stage", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(checked_git(top, &args, None, None)?.stdout)
}

fn head_state(top: &str) -> napi::Result<String> {
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

fn apply_snapshot(workspace: &str, request: &NativeApplySnapshotRequest) -> napi::Result<()> {
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

enum RepositoryOperation {
    Discover,
    Capture(NativeCaptureRequest),
    ChangedPaths(NativeTreePairRequest),
    IndexState(Vec<String>),
    HeadState,
    Gitlinks(NativeGitlinksRequest),
    Apply(NativeApplySnapshotRequest),
}

pub struct RepositoryTask {
    workspace: String,
    operation: Option<RepositoryOperation>,
}

impl Task for RepositoryTask {
    type Output = NativeRepositoryOutput;
    type JsValue = NativeRepositoryOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let operation = self.operation.take().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "native repository operation was unavailable".to_owned(),
            )
        })?;
        match operation {
            RepositoryOperation::Discover => match repository_root(&self.workspace) {
                Ok(root) => Ok(NativeRepositoryOutput {
                    kind: "discovery".to_owned(),
                    ready: Some(true),
                    root: Some(root.to_string_lossy().into_owned()),
                    reason: None,
                    tree: None,
                    paths: None,
                    bytes: None,
                    text: None,
                    gitlinks: None,
                }),
                Err(error) => Ok(NativeRepositoryOutput {
                    kind: "discovery".to_owned(),
                    ready: Some(false),
                    root: None,
                    reason: Some(error.reason),
                    tree: None,
                    paths: None,
                    bytes: None,
                    text: None,
                    gitlinks: None,
                }),
            },
            RepositoryOperation::Capture(request) => Ok(NativeRepositoryOutput {
                kind: "tree".to_owned(),
                ready: None,
                root: None,
                reason: None,
                tree: Some(capture_tree(
                    &self.workspace,
                    &request.forced,
                    request.full,
                )?),
                paths: None,
                bytes: None,
                text: None,
                gitlinks: None,
            }),
            RepositoryOperation::ChangedPaths(request) => {
                let top = repository_root(&self.workspace)?;
                let output = checked_git(
                    &top.to_string_lossy(),
                    &[
                        "diff",
                        "--name-only",
                        "-z",
                        "--no-renames",
                        "--no-ext-diff",
                        "--no-textconv",
                        &request.before,
                        &request.after,
                        "--",
                    ],
                    None,
                    None,
                )?;
                Ok(NativeRepositoryOutput {
                    kind: "paths".to_owned(),
                    ready: None,
                    root: None,
                    reason: None,
                    tree: None,
                    paths: Some(nul_paths(&output.stdout)?),
                    bytes: None,
                    text: None,
                    gitlinks: None,
                })
            }
            RepositoryOperation::IndexState(paths) => {
                let top = repository_root(&self.workspace)?;
                Ok(NativeRepositoryOutput {
                    kind: "bytes".to_owned(),
                    ready: None,
                    root: None,
                    reason: None,
                    tree: None,
                    paths: None,
                    bytes: Some(index_state(&top.to_string_lossy(), &paths)?.into()),
                    text: None,
                    gitlinks: None,
                })
            }
            RepositoryOperation::HeadState => {
                let top = repository_root(&self.workspace)?;
                Ok(NativeRepositoryOutput {
                    kind: "text".to_owned(),
                    ready: None,
                    root: None,
                    reason: None,
                    tree: None,
                    paths: None,
                    bytes: None,
                    text: Some(head_state(&top.to_string_lossy())?),
                    gitlinks: None,
                })
            }
            RepositoryOperation::Gitlinks(request) => {
                let top = repository_root(&self.workspace)?;
                Ok(NativeRepositoryOutput {
                    kind: "gitlinks".to_owned(),
                    ready: None,
                    root: None,
                    reason: None,
                    tree: None,
                    paths: None,
                    bytes: None,
                    text: None,
                    gitlinks: Some(gitlinks(&top.to_string_lossy(), &request)?),
                })
            }
            RepositoryOperation::Apply(request) => {
                apply_snapshot(&self.workspace, &request)?;
                Ok(NativeRepositoryOutput {
                    kind: "applied".to_owned(),
                    ready: None,
                    root: None,
                    reason: None,
                    tree: None,
                    paths: None,
                    bytes: None,
                    text: None,
                    gitlinks: None,
                })
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct GitCommandTask {
    cwd: String,
    request: NativeGitCommandRequest,
    cancelled: Arc<AtomicBool>,
}

impl Task for GitCommandTask {
    type Output = NativeGitCommandOutput;
    type JsValue = NativeGitCommandOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let output = run_git(
            &self.cwd,
            &self.request.args,
            self.request.index_file.as_deref(),
            self.request.input.as_deref(),
            Some(&self.cancelled),
        )
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
        Ok(NativeGitCommandOutput {
            stdout: output.stdout.into(),
            stderr: output.stderr.into(),
            exit_code: output.exit_code,
            interrupted: self.cancelled.load(std::sync::atomic::Ordering::Relaxed),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub struct NativeGitRepository {
    cwd: String,
}

#[napi]
impl NativeGitRepository {
    #[napi(constructor, catch_unwind)]
    pub fn new(cwd: String) -> napi::Result<Self> {
        if cwd.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "Git repository path is required".to_owned(),
            ));
        }
        Ok(Self { cwd })
    }

    #[napi(catch_unwind)]
    pub fn run(
        &self,
        request: NativeGitCommandRequest,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<GitCommandTask> {
        AsyncTask::new(GitCommandTask {
            cwd: self.cwd.clone(),
            request,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn discover(&self) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::Discover),
        })
    }

    #[napi(catch_unwind)]
    pub fn capture(&self, request: NativeCaptureRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::Capture(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn changed_paths(&self, request: NativeTreePairRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::ChangedPaths(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn index_state(&self, paths: Vec<String>) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::IndexState(paths)),
        })
    }

    #[napi(catch_unwind)]
    pub fn head_state(&self) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::HeadState),
        })
    }

    #[napi(catch_unwind)]
    pub fn gitlinks(&self, request: NativeGitlinksRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::Gitlinks(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn apply_snapshot(&self, request: NativeApplySnapshotRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            workspace: self.cwd.clone(),
            operation: Some(RepositoryOperation::Apply(request)),
        })
    }
}

#[napi(object)]
pub struct NativeReviewDiffRequest {
    pub cwd: String,
    pub base: Option<String>,
    pub aborted: Option<bool>,
}

#[napi(object)]
pub struct NativeReviewDiffOutput {
    pub output: String,
}

fn git_text(cwd: &str, args: &[&str], cancelled: &AtomicBool) -> napi::Result<String> {
    let owned = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(cwd, &owned, None, None, Some(cancelled))
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(Error::new(
            Status::Cancelled,
            "Git command interrupted".to_owned(),
        ));
    }
    if output.exit_code != 0 {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        let suffix = if detail.is_empty() {
            format!(" with exit code {}", output.exit_code)
        } else {
            format!(": {detail}")
        };
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "git {} failed{suffix}",
                args.first().copied().unwrap_or("command")
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned())
}

pub struct ReviewDiffTask {
    request: NativeReviewDiffRequest,
    cancelled: Arc<AtomicBool>,
}

impl Task for ReviewDiffTask {
    type Output = NativeReviewDiffOutput;
    type JsValue = NativeReviewDiffOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.request.aborted.unwrap_or(false) {
            return Err(Error::new(
                Status::Cancelled,
                "Git command interrupted".to_owned(),
            ));
        }
        let root = git_text(
            &self.request.cwd,
            &["rev-parse", "--show-toplevel"],
            &self.cancelled,
        )?;
        let status = git_text(
            &root,
            &["status", "--short", "--untracked-files=all"],
            &self.cancelled,
        )?;
        let Some(base) = self.request.base.as_deref() else {
            if status.is_empty() {
                return Ok(NativeReviewDiffOutput {
                    output: "No working-tree changes.".to_owned(),
                });
            }
            let staged = git_text(
                &root,
                &["diff", "--cached", "--no-ext-diff", "--find-renames", "--"],
                &self.cancelled,
            )?;
            let unstaged = git_text(
                &root,
                &["diff", "--no-ext-diff", "--find-renames", "--"],
                &self.cancelled,
            )?;
            return Ok(NativeReviewDiffOutput {
                output: [
                    "Git status:".to_owned(),
                    status,
                    String::new(),
                    "Staged diff:".to_owned(),
                    if staged.is_empty() { "(none)".to_owned() } else { staged },
                    String::new(),
                    "Unstaged diff:".to_owned(),
                    if unstaged.is_empty() { "(none)".to_owned() } else { unstaged },
                    String::new(),
                    "Untracked file contents are not included in Git diffs. Inspect every untracked path listed in the status.".to_owned(),
                ]
                .join("\n"),
            });
        };
        let base_commit = git_text(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{base}^{{commit}}"),
            ],
            &self.cancelled,
        )?;
        let merge_base = git_text(
            &root,
            &["merge-base", &base_commit, "HEAD"],
            &self.cancelled,
        )?;
        let diff = git_text(
            &root,
            &["diff", "--no-ext-diff", "--find-renames", &merge_base, "--"],
            &self.cancelled,
        )?;
        let has_untracked = status.lines().any(|line| line.starts_with("?? "));
        if diff.is_empty() && !has_untracked {
            return Ok(NativeReviewDiffOutput {
                output: format!("No changes since the merge base with {base}."),
            });
        }
        Ok(NativeReviewDiffOutput {
            output: [
                format!("Base: {base_commit}"),
                format!("Merge base: {merge_base}"),
                String::new(),
                "Git status:".to_owned(),
                if status.is_empty() { "(clean)".to_owned() } else { status },
                String::new(),
                "Diff:".to_owned(),
                if diff.is_empty() { "(no tracked changes)".to_owned() } else { diff },
                String::new(),
                "Untracked file contents are not included in Git diffs. Inspect every untracked path listed in the status.".to_owned(),
            ]
            .join("\n"),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeReviewDiff", catch_unwind)]
pub fn native_review_diff(
    request: NativeReviewDiffRequest,
    signal: Option<AbortSignal>,
) -> napi::Result<AsyncTask<ReviewDiffTask>> {
    if request.cwd.is_empty() {
        return Err(Error::new(Status::InvalidArg, "cwd is required".to_owned()));
    }
    if request
        .base
        .as_ref()
        .is_some_and(|base| base.trim().is_empty())
    {
        return Err(Error::new(
            Status::InvalidArg,
            "base must be a non-empty Git revision".to_owned(),
        ));
    }
    let request = NativeReviewDiffRequest {
        cwd: request.cwd,
        base: request.base.map(|base| base.trim().to_owned()),
        aborted: request.aborted,
    };
    Ok(AsyncTask::new(ReviewDiffTask {
        request,
        cancelled: cancellation_flag(signal),
    }))
}
