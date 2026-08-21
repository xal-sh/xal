use super::*;

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
