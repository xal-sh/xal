use super::*;
#[napi(object)]
pub struct NativeGlobOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub pattern: Option<String>,
    pub aborted: Option<bool>,
}
pub struct GlobTask(xal_services::search::GlobTask);
impl Task for GlobTask {
    type Output = xal_services::search::SearchResult;
    type JsValue = NativeSearchResult;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}
#[napi(js_name = "nativeGlob", catch_unwind)]
pub fn native_glob(options: NativeGlobOptions, signal: Option<AbortSignal>) -> AsyncTask<GlobTask> {
    AsyncTask::new(GlobTask(xal_services::search::glob(
        xal_services::search::GlobOptions {
            cwd: options.cwd,
            target: options.target,
            pattern: options.pattern,
            aborted: options.aborted,
        },
        cancellation_flag(signal),
    )))
}
