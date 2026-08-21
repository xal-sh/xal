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

mod git;
mod lifecycle;
mod marker;
mod tool;

use lifecycle::{Operation, WorktreeTask};

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
fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn canonical(path: impl AsRef<Path>) -> napi::Result<PathBuf> {
    fs::canonicalize(path).map_err(|error| failed(error.to_string()))
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
