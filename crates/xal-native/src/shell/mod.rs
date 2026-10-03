#![cfg_attr(test, allow(dead_code))]
use crate::process::{NativeEnvironmentVariable, NativeProcessTermination};
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;
#[napi(object)]
pub struct NativeShellRequest {
    pub session_id: String,
    pub sandbox_id: String,
    pub command: String,
    pub cwd: String,
    pub persistent_launch: Vec<String>,
    pub isolated_launch: Vec<String>,
    pub environment: Vec<NativeEnvironmentVariable>,
}
pub struct WaitShellTask(xal_services::shell::WaitShellTask);
impl Task for WaitShellTask {
    type Output = xal_services::process::ProcessTermination;
    type JsValue = NativeProcessTermination;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}
#[napi]
pub struct NativeShellExecution(xal_services::shell::ShellExecution);
#[napi]
impl NativeShellExecution {
    #[napi(catch_unwind)]
    pub fn drain(&self) -> Buffer {
        self.0.drain().into()
    }
    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        self.0.output_closed()
    }
    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitShellTask> {
        AsyncTask::new(WaitShellTask(self.0.wait()))
    }
    #[napi(catch_unwind)]
    pub fn set_timeout(&self, milliseconds: u32) {
        self.0.set_timeout(milliseconds);
    }
    #[napi(catch_unwind)]
    pub fn clear_timeout(&self) {
        self.0.clear_timeout();
    }
    #[napi(catch_unwind)]
    pub fn timed_out(&self) -> bool {
        self.0.timed_out()
    }
    #[napi(catch_unwind)]
    pub fn terminate(&self) {
        self.0.terminate();
    }
    #[napi(catch_unwind)]
    pub fn kill(&self) {
        self.0.kill();
    }
}
#[napi]
pub struct NativeShellManager(xal_services::shell::ShellManager);
#[napi]
impl NativeShellManager {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self(xal_services::shell::ShellManager::new())
    }
    #[napi(catch_unwind)]
    pub fn execute(&self, request: NativeShellRequest) -> napi::Result<NativeShellExecution> {
        Ok(NativeShellExecution(
            self.0
                .execute(xal_services::shell::ShellRequest {
                    session_id: request.session_id,
                    sandbox_id: request.sandbox_id,
                    command: request.command,
                    cwd: request.cwd,
                    persistent_launch: request.persistent_launch,
                    isolated_launch: request.isolated_launch,
                    environment: request.environment.into_iter().map(Into::into).collect(),
                })
                .map_err(crate::tool_contracts::io_error)?,
        ))
    }
    #[napi(catch_unwind)]
    pub fn dispose_session(&self, session_id: String) {
        self.0.dispose_session(session_id);
    }
    #[napi(catch_unwind)]
    pub fn dispose_all(&self) {
        self.0.dispose_all();
    }
}
