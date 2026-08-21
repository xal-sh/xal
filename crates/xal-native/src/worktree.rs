#![cfg_attr(test, allow(dead_code))]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, atomic::AtomicBool};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::file_tools::NativeToolOutput;
use crate::git::run_git;
use crate::tool_contracts::cancellation_flag;

static MUTATION: OnceLock<Mutex<()>> = OnceLock::new();

#[napi(object)]
#[derive(Clone)]
pub struct NativeManagedWorktree {
    pub version: u32,
    pub repository_root: String,
    pub original_cwd: String,
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub base_commit: String,
}

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

#[napi(object)]
pub struct NativeWorktreeRequest {
    pub cwd: String,
    pub worktrees_dir: String,
    pub app_name: String,
    pub display_name: String,
    pub marker_name: String,
    pub name: Option<String>,
    pub worktree: Option<NativeManagedWorktree>,
    pub force: Option<bool>,
    pub aborted: Option<bool>,
}

#[napi(object)]
pub struct NativeWorktreeResult {
    pub found: bool,
    pub worktree: Option<NativeManagedWorktree>,
}

#[derive(Clone)]
enum Operation {
    Create,
    Lookup,
    Remove,
    Unmanage,
}

pub struct WorktreeTask {
    operation: Operation,
    request: NativeWorktreeRequest,
    cancelled: Arc<AtomicBool>,
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn canonical(path: impl AsRef<Path>) -> napi::Result<PathBuf> {
    fs::canonicalize(path).map_err(|error| failed(error.to_string()))
}

fn checked_git(cwd: &Path, args: &[&str], cancelled: &AtomicBool) -> napi::Result<String> {
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

fn cleanup_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
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

fn rollback_created(repository_root: &Path, path: &Path, branch: &str) -> Vec<String> {
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

fn rollback_error(error: Error, failures: Vec<String>) -> Error {
    if failures.is_empty() {
        return error;
    }
    failed(format!("{error}; rollback failed: {}", failures.join("; ")))
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

fn suffix() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{time:024x}{:08x}{count:08x}", std::process::id())
}

fn repository_key(path: &Path) -> String {
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

fn write_new_secure(path: &Path, text: &str) -> napi::Result<()> {
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

fn marker_json(worktree: &NativeManagedWorktree) -> napi::Result<String> {
    serde_json::to_string_pretty(&MarkerRecord::from(worktree))
        .map(|text| format!("{text}\n"))
        .map_err(|error| failed(error.to_string()))
}

fn parse_marker(text: &str) -> Option<NativeManagedWorktree> {
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

fn marker_path(
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

fn lookup(
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

fn create(
    request: &NativeWorktreeRequest,
    cancelled: &AtomicBool,
) -> napi::Result<NativeManagedWorktree> {
    let cwd = PathBuf::from(&request.cwd);
    let current_root = canonical(checked_git(
        &cwd,
        &["rev-parse", "--show-toplevel"],
        cancelled,
    )?)?;
    let listing = checked_git(&cwd, &["worktree", "list", "--porcelain"], cancelled)?;
    let primary = listing
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .ok_or_else(|| failed("Git did not report a primary worktree"))?;
    let repository_root = canonical(primary)?;
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
    let path = PathBuf::from(&request.worktrees_dir)
        .join(repository_key(&repository_root))
        .join(format!("{label}-{suffix}"));
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| failed("worktree parent is unavailable"))?,
    )
    .map_err(|error| failed(error.to_string()))?;
    if request.aborted.unwrap_or(false) || cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(failed("Worktree creation interrupted"));
    }
    if let Err(error) = checked_git(
        &repository_root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path.to_string_lossy(),
            &base_commit,
        ],
        cancelled,
    ) {
        return Err(rollback_error(
            error,
            rollback_created(&repository_root, &path, &branch),
        ));
    }
    let worktree = NativeManagedWorktree {
        version: 1,
        repository_root: repository_root.to_string_lossy().into_owned(),
        original_cwd: original_cwd.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        cwd: path.join(relative_cwd).to_string_lossy().into_owned(),
        branch: branch.clone(),
        base_commit,
    };
    let result = (|| {
        if !Path::new(&worktree.cwd).exists() {
            return Err(failed(format!(
                "worktree checkout is missing {}",
                worktree.cwd
            )));
        }
        let marker = marker_path(&path, request, cancelled)?;
        write_new_secure(&marker, &marker_json(&worktree)?)
    })();
    if let Err(error) = result {
        return Err(rollback_error(
            error,
            rollback_created(&repository_root, &path, &branch),
        ));
    }
    Ok(worktree)
}

fn require_current(
    request: &NativeWorktreeRequest,
    cancelled: &AtomicBool,
) -> napi::Result<NativeManagedWorktree> {
    let expected = request
        .worktree
        .as_ref()
        .ok_or_else(|| failed("managed worktree record is required"))?;
    let mut lookup_request = NativeWorktreeRequest {
        cwd: expected.path.clone(),
        worktrees_dir: request.worktrees_dir.clone(),
        app_name: request.app_name.clone(),
        display_name: request.display_name.clone(),
        marker_name: request.marker_name.clone(),
        name: None,
        worktree: None,
        force: None,
        aborted: request.aborted,
    };
    let current = lookup(&lookup_request, cancelled)?;
    lookup_request.cwd.clear();
    match current {
        Some(current) if current.path == expected.path => Ok(current),
        _ => Err(failed(format!(
            "{} is not a managed {} worktree",
            expected.path, request.display_name
        ))),
    }
}

impl Task for WorktreeTask {
    type Output = NativeWorktreeResult;
    type JsValue = NativeWorktreeResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.request.aborted.unwrap_or(false) {
            let message = match self.operation {
                Operation::Create => "Worktree creation interrupted",
                Operation::Remove => "Worktree removal interrupted",
                Operation::Lookup | Operation::Unmanage => "Git command interrupted",
            };
            return Err(failed(message));
        }
        let _guard: Option<MutexGuard<'_, ()>> = match self.operation {
            Operation::Lookup => None,
            _ => Some(
                MUTATION
                    .get_or_init(|| Mutex::new(()))
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            ),
        };
        match self.operation {
            Operation::Create => Ok(NativeWorktreeResult {
                found: true,
                worktree: Some(create(&self.request, &self.cancelled)?),
            }),
            Operation::Lookup => {
                let worktree = lookup(&self.request, &self.cancelled)?;
                Ok(NativeWorktreeResult {
                    found: worktree.is_some(),
                    worktree,
                })
            }
            Operation::Remove => {
                let current = require_current(&self.request, &self.cancelled)?;
                if !self.request.force.unwrap_or(false) {
                    let status = checked_git(
                        Path::new(&current.path),
                        &[
                            "status",
                            "--porcelain",
                            "--untracked-files=all",
                            "--ignored",
                        ],
                        &self.cancelled,
                    )?;
                    if !status.is_empty() {
                        return Err(failed(
                            "worktree has uncommitted or ignored files; preserve them or retry with force to discard them",
                        ));
                    }
                }
                if self.request.aborted.unwrap_or(false)
                    || self.cancelled.load(std::sync::atomic::Ordering::Relaxed)
                {
                    return Err(failed("Worktree removal interrupted"));
                }
                let mut args = vec!["worktree", "remove"];
                if self.request.force.unwrap_or(false) {
                    args.push("--force");
                }
                args.push(&current.path);
                checked_git(Path::new(&current.repository_root), &args, &self.cancelled)?;
                Ok(NativeWorktreeResult {
                    found: false,
                    worktree: None,
                })
            }
            Operation::Unmanage => {
                let current = require_current(&self.request, &self.cancelled)?;
                fs::remove_file(marker_path(
                    Path::new(&current.path),
                    &self.request,
                    &self.cancelled,
                )?)
                .map_err(|error| failed(error.to_string()))?;
                Ok(NativeWorktreeResult {
                    found: false,
                    worktree: None,
                })
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(object)]
pub struct NativeWorktreeToolRequest {
    pub operation: String,
    pub name: Option<String>,
    pub action: Option<String>,
    pub path: Option<String>,
    pub force: Option<bool>,
}

#[napi(object)]
pub struct NativeWorktreeToolPreparation {
    pub operation: String,
    pub name: Option<String>,
    pub action: Option<String>,
    pub path: Option<String>,
    pub force: bool,
}

#[napi(object)]
pub struct NativeWorktreeToolFormatRequest {
    pub operation: String,
    pub action: Option<String>,
    pub display_path: String,
    pub worktree: NativeManagedWorktree,
}

#[napi(js_name = "nativePrepareWorktreeTool", catch_unwind)]
pub fn native_prepare_worktree_tool(
    request: NativeWorktreeToolRequest,
) -> napi::Result<NativeWorktreeToolPreparation> {
    match request.operation.as_str() {
        "enter" => {
            let name = request.name.as_deref().map(str::trim).unwrap_or("");
            if name.is_empty() {
                return Err(failed("name is required"));
            }
            if name.encode_utf16().count() > 80 {
                return Err(failed("name must be at most 80 characters"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: Some(name.to_owned()),
                action: None,
                path: None,
                force: false,
            })
        }
        "exit" => {
            let action = request.action.as_deref().unwrap_or("");
            if action != "keep" && action != "remove" {
                return Err(failed("action must be \"keep\" or \"remove\""));
            }
            let force = request.force.unwrap_or(false);
            if action == "keep" && force {
                return Err(failed("force is valid only when removing a worktree"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: None,
                action: Some(action.to_owned()),
                path: None,
                force,
            })
        }
        "remove" => {
            let path = request.path.as_deref().map(str::trim).unwrap_or("");
            if path.is_empty() {
                return Err(failed("path is required"));
            }
            Ok(NativeWorktreeToolPreparation {
                operation: request.operation,
                name: None,
                action: None,
                path: Some(path.to_owned()),
                force: request.force.unwrap_or(false),
            })
        }
        _ => Err(failed("native worktree tool operation is invalid")),
    }
}

#[napi(js_name = "nativeFormatWorktreeTool", catch_unwind)]
pub fn native_format_worktree_tool(
    request: NativeWorktreeToolFormatRequest,
) -> napi::Result<NativeToolOutput> {
    let output = match request.operation.as_str() {
        "enter" => [
            format!("Entered isolated worktree {}.", request.display_path),
            format!("Branch: {}", request.worktree.branch),
            format!("Base: {}", request.worktree.base_commit),
            "Task agents now inherit this worktree.".to_owned(),
        ]
        .join("\n"),
        "exit" if request.action.as_deref() == Some("keep") => format!(
            "Left {} intact on branch {}.",
            request.display_path, request.worktree.branch
        ),
        "exit" if request.action.as_deref() == Some("remove") => format!(
            "Removed {}. Branch {} remains available.",
            request.display_path, request.worktree.branch
        ),
        "remove" => format!(
            "Removed {}. Branch {} remains available.",
            request.display_path, request.worktree.branch
        ),
        _ => return Err(failed("native worktree tool format request is invalid")),
    };
    Ok(NativeToolOutput {
        output: output.into(),
    })
}

fn task(
    operation: Operation,
    request: NativeWorktreeRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorktreeTask> {
    AsyncTask::new(WorktreeTask {
        operation,
        request,
        cancelled: cancellation_flag(signal),
    })
}

#[napi(js_name = "nativeCreateManagedWorktree", catch_unwind)]
pub fn native_create_managed_worktree(
    request: NativeWorktreeRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorktreeTask> {
    task(Operation::Create, request, signal)
}

#[napi(js_name = "nativeManagedWorktreeAt", catch_unwind)]
pub fn native_managed_worktree_at(
    request: NativeWorktreeRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorktreeTask> {
    task(Operation::Lookup, request, signal)
}

#[napi(js_name = "nativeRemoveManagedWorktree", catch_unwind)]
pub fn native_remove_managed_worktree(
    request: NativeWorktreeRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorktreeTask> {
    task(Operation::Remove, request, signal)
}

#[napi(js_name = "nativeUnmanageWorktree", catch_unwind)]
pub fn native_unmanage_worktree(
    request: NativeWorktreeRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorktreeTask> {
    task(Operation::Unmanage, request, signal)
}

#[cfg(test)]
mod tests {
    use super::{
        NativeManagedWorktree, NativeWorktreeToolRequest, marker_json,
        native_prepare_worktree_tool, parse_marker,
    };

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

    #[test]
    fn validates_raw_worktree_tool_requests() {
        let prepared = native_prepare_worktree_tool(NativeWorktreeToolRequest {
            operation: "enter".to_owned(),
            name: Some("  purpose  ".to_owned()),
            action: None,
            path: None,
            force: None,
        })
        .expect("enter request should be valid");
        assert_eq!(prepared.name.as_deref(), Some("purpose"));
        let result = native_prepare_worktree_tool(NativeWorktreeToolRequest {
            operation: "exit".to_owned(),
            name: None,
            action: Some("keep".to_owned()),
            path: None,
            force: Some(true),
        });
        match result {
            Ok(_) => panic!("keep force should be rejected"),
            Err(error) => assert!(error.reason.contains("force is valid only")),
        }
    }
}
