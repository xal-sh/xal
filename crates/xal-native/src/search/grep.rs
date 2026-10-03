use super::*;
#[napi(object)]
pub struct NativeGrepOptions {
    pub cwd: String,
    pub target: Option<String>,
    pub glob: Option<String>,
    pub pattern: Option<String>,
    pub output_mode: Option<String>,
    pub case_insensitive: Option<bool>,
    pub aborted: Option<bool>,
}
pub struct GrepTask(xal_services::search::GrepTask);
impl Task for GrepTask {
    type Output = xal_services::search::SearchResult;
    type JsValue = NativeSearchResult;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}
#[napi(js_name = "nativeGrep", catch_unwind)]
pub fn native_grep(options: NativeGrepOptions, signal: Option<AbortSignal>) -> AsyncTask<GrepTask> {
    AsyncTask::new(GrepTask(xal_services::search::grep(
        xal_services::search::GrepOptions {
            cwd: options.cwd,
            target: options.target,
            glob: options.glob,
            pattern: options.pattern,
            output_mode: options.output_mode,
            case_insensitive: options.case_insensitive,
            aborted: options.aborted,
        },
        cancellation_flag(signal),
    )))
}
