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
    repository: Arc<service::Repository>,
    operation: Option<RepositoryOperation>,
}

impl RepositoryTask {
    fn top(&self) -> napi::Result<String> {
        self.repository.root().map(str::to_owned).map_err(io_error)
    }
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
            RepositoryOperation::Discover => match self.top() {
                Ok(root) => Ok(NativeRepositoryOutput {
                    kind: "discovery".to_owned(),
                    ready: Some(true),
                    root: Some(root),
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
                tree: Some(self.repository.capture(&request.into()).map_err(io_error)?),
                paths: None,
                bytes: None,
                text: None,
                gitlinks: None,
            }),
            RepositoryOperation::ChangedPaths(request) => Ok(NativeRepositoryOutput {
                kind: "paths".to_owned(),
                ready: None,
                root: None,
                reason: None,
                tree: None,
                paths: Some(
                    self.repository
                        .changed_paths(&request.into())
                        .map_err(io_error)?,
                ),
                bytes: None,
                text: None,
                gitlinks: None,
            }),
            RepositoryOperation::IndexState(paths) => Ok(NativeRepositoryOutput {
                kind: "bytes".to_owned(),
                ready: None,
                root: None,
                reason: None,
                tree: None,
                paths: None,
                bytes: Some(
                    self.repository
                        .index_state(&paths)
                        .map_err(io_error)?
                        .into(),
                ),
                text: None,
                gitlinks: None,
            }),
            RepositoryOperation::HeadState => Ok(NativeRepositoryOutput {
                kind: "text".to_owned(),
                ready: None,
                root: None,
                reason: None,
                tree: None,
                paths: None,
                bytes: None,
                text: Some(self.repository.head_state().map_err(io_error)?),
                gitlinks: None,
            }),
            RepositoryOperation::Gitlinks(request) => Ok(NativeRepositoryOutput {
                kind: "gitlinks".to_owned(),
                ready: None,
                root: None,
                reason: None,
                tree: None,
                paths: None,
                bytes: None,
                text: None,
                gitlinks: Some(
                    self.repository
                        .gitlinks(&request.into())
                        .map_err(io_error)?
                        .into_iter()
                        .map(Into::into)
                        .collect(),
                ),
            }),
            RepositoryOperation::Apply(request) => {
                self.repository
                    .apply_snapshot(&request.into())
                    .map_err(io_error)?;
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
    repository: Arc<service::Repository>,
}

#[napi]
impl NativeGitRepository {
    #[napi(constructor, catch_unwind)]
    pub fn new(cwd: String) -> napi::Result<Self> {
        Ok(Self {
            repository: Arc::new(service::Repository::new(cwd.clone()).map_err(io_error)?),
            cwd,
        })
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
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::Discover),
        })
    }

    #[napi(catch_unwind)]
    pub fn capture(&self, request: NativeCaptureRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::Capture(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn changed_paths(&self, request: NativeTreePairRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::ChangedPaths(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn index_state(&self, paths: Vec<String>) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::IndexState(paths)),
        })
    }

    #[napi(catch_unwind)]
    pub fn head_state(&self) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::HeadState),
        })
    }

    #[napi(catch_unwind)]
    pub fn gitlinks(&self, request: NativeGitlinksRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::Gitlinks(request)),
        })
    }

    #[napi(catch_unwind)]
    pub fn apply_snapshot(&self, request: NativeApplySnapshotRequest) -> AsyncTask<RepositoryTask> {
        AsyncTask::new(RepositoryTask {
            repository: self.repository.clone(),
            operation: Some(RepositoryOperation::Apply(request)),
        })
    }
}
