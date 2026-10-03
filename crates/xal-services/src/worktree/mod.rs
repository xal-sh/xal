use std::fs;
use std::io::{Error, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git::run_git;

mod git;
mod lifecycle;
mod marker;
mod tool;

pub use lifecycle::{create_managed_worktree, remove_managed_worktree, unmanage_worktree};
pub use marker::lookup as managed_worktree_at;
pub use tool::{WorktreeAction, WorktreeTool, format_worktree_tool};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedWorktree {
    pub version: u32,
    pub repository_root: String,
    pub original_cwd: String,
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Clone)]
pub struct WorktreeRequest {
    pub cwd: String,
    pub worktrees_dir: String,
    pub app_name: String,
    pub display_name: String,
    pub marker_name: String,
    pub name: Option<String>,
    pub worktree: Option<ManagedWorktree>,
    pub force: Option<bool>,
    pub aborted: Option<bool>,
}

fn failed(message: impl Into<String>) -> Error {
    Error::other(message.into())
}

fn interrupted(message: &str) -> Error {
    Error::new(std::io::ErrorKind::Interrupted, message)
}

fn canonical(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    fs::canonicalize(path)
}

fn path_text(path: &Path) -> std::io::Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| failed("worktree path is not Unicode"))
}
