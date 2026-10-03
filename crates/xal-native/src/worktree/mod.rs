#![cfg_attr(test, allow(dead_code))]

use std::sync::{Arc, atomic::AtomicBool};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Task};
use napi_derive::napi;

use crate::file_tools::NativeToolOutput;
use crate::tool_contracts::{cancellation_flag, io_error};
use xal_services::worktree as service;

mod lifecycle;
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

impl From<NativeManagedWorktree> for service::ManagedWorktree {
    fn from(value: NativeManagedWorktree) -> Self {
        Self {
            version: value.version,
            repository_root: value.repository_root,
            original_cwd: value.original_cwd,
            path: value.path,
            cwd: value.cwd,
            branch: value.branch,
            base_commit: value.base_commit,
        }
    }
}

impl From<service::ManagedWorktree> for NativeManagedWorktree {
    fn from(value: service::ManagedWorktree) -> Self {
        Self {
            version: value.version,
            repository_root: value.repository_root,
            original_cwd: value.original_cwd,
            path: value.path,
            cwd: value.cwd,
            branch: value.branch,
            base_commit: value.base_commit,
        }
    }
}
