use super::git::{checked_git, rollback_created, rollback_error};
use super::marker::{lookup, marker_json, marker_path, repository_key, suffix, write_new_secure};
use super::*;

static MUTATION: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Clone)]
pub(super) enum Operation {
    Create,
    Lookup,
    Remove,
    Unmanage,
}

pub struct WorktreeTask {
    pub(super) operation: Operation,
    pub(super) request: NativeWorktreeRequest,
    pub(super) cancelled: Arc<AtomicBool>,
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
