#![cfg_attr(test, allow(dead_code))]
use napi::bindgen_prelude::{AsyncTask, Buffer, Utf16String};
use napi::{Env, Task};
use napi_derive::napi;
#[napi(object)]
pub struct NativeEnvironmentVariable {
    pub name: String,
    pub value: String,
}
impl From<NativeEnvironmentVariable> for xal_services::process::EnvironmentVariable {
    fn from(value: NativeEnvironmentVariable) -> Self {
        Self {
            name: value.name,
            value: value.value,
        }
    }
}
#[napi(object)]
pub struct NativeProcessRequest {
    pub launch: Vec<String>,
    pub cwd: String,
    pub environment: Vec<NativeEnvironmentVariable>,
    pub stdin: bool,
}
impl From<NativeProcessRequest> for xal_services::process::ProcessRequest {
    fn from(value: NativeProcessRequest) -> Self {
        Self {
            launch: value.launch,
            cwd: value.cwd,
            environment: value.environment.into_iter().map(Into::into).collect(),
            stdin: value.stdin,
        }
    }
}
#[napi(object)]
pub struct NativeProcessTermination {
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}
impl From<xal_services::process::ProcessTermination> for NativeProcessTermination {
    fn from(value: xal_services::process::ProcessTermination) -> Self {
        Self {
            status: value.status,
            exit_code: value.exit_code,
            signal: value.signal,
        }
    }
}
pub struct WaitProcessTask(xal_services::process::WaitProcessTask);
impl Task for WaitProcessTask {
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
pub struct NativeProcess(xal_services::process::Process);
#[napi]
impl NativeProcess {
    #[napi(catch_unwind)]
    pub fn drain(&self) -> Buffer {
        self.0.drain().into()
    }
    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        self.0.output_closed()
    }
    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitProcessTask> {
        AsyncTask::new(WaitProcessTask(self.0.wait()))
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
impl NativeProcess {
    #[napi(factory, catch_unwind)]
    pub fn spawn(request: NativeProcessRequest) -> napi::Result<Self> {
        Ok(Self(
            xal_services::process::Process::spawn(request.into())
                .map_err(crate::tool_contracts::io_error)?,
        ))
    }
    #[napi(catch_unwind)]
    pub fn write(&self, bytes: Buffer) -> napi::Result<()> {
        self.0
            .write(&bytes)
            .map_err(crate::tool_contracts::io_error)
    }
    #[napi(catch_unwind)]
    pub fn close_stdin(&self) {
        self.0.close_stdin();
    }
}
#[napi(js_name = "nativeNormalizeProcessOutput", catch_unwind)]
pub fn native_normalize_process_output(output: Utf16String) -> Utf16String {
    xal_services::process::normalize_process_output(output.to_vec()).into()
}
