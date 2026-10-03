use super::*;

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

impl Task for WorktreeTask {
    type Output = Option<service::ManagedWorktree>;
    type JsValue = NativeWorktreeResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let request = service::WorktreeRequest {
            cwd: self.request.cwd.clone(),
            worktrees_dir: self.request.worktrees_dir.clone(),
            app_name: self.request.app_name.clone(),
            display_name: self.request.display_name.clone(),
            marker_name: self.request.marker_name.clone(),
            name: self.request.name.clone(),
            worktree: self.request.worktree.clone().map(Into::into),
            force: self.request.force,
            aborted: self.request.aborted,
        };
        let cancelled = || self.cancelled.load(std::sync::atomic::Ordering::Relaxed);
        match self.operation {
            Operation::Create => service::create_managed_worktree(&request, &cancelled).map(Some),
            Operation::Lookup => service::managed_worktree_at(&request, &cancelled),
            Operation::Remove => {
                service::remove_managed_worktree(&request, &cancelled).map(|()| None)
            }
            Operation::Unmanage => service::unmanage_worktree(&request, &cancelled).map(|()| None),
        }
        .map_err(io_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeWorktreeResult {
            found: output.is_some(),
            worktree: output.map(Into::into),
        })
    }
}
