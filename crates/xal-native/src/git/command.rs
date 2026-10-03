use super::*;

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

pub struct GitCommandTask {
    pub(super) cwd: String,
    pub(super) request: NativeGitCommandRequest,
    pub(super) cancelled: Arc<AtomicBool>,
}

impl Task for GitCommandTask {
    type Output = service::GitOutput;
    type JsValue = NativeGitCommandOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        service::run_git(
            &self.cwd,
            &self.request.args,
            self.request.index_file.as_deref(),
            self.request.input.as_deref(),
            Some(&|| self.cancelled.load(std::sync::atomic::Ordering::Relaxed)),
        )
        .map_err(io_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeGitCommandOutput {
            stdout: output.stdout.into(),
            stderr: output.stderr.into(),
            exit_code: output.exit_code,
            interrupted: output.interrupted,
        })
    }
}
