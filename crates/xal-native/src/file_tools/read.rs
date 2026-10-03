use super::*;

#[napi(object)]
pub struct NativeReadRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub offset: Option<f64>,
    pub limit: Option<f64>,
}

pub struct ReadTask(xal_services::file_tools::ReadTask);

impl Task for ReadTask {
    type Output = xal_services::file_tools::FileToolOutput;
    type JsValue = NativeFileToolOutput;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(js_name = "nativeReadFile", catch_unwind)]
pub fn native_read_file(request: NativeReadRequest) -> napi::Result<AsyncTask<ReadTask>> {
    let task = xal_services::file_tools::read_file(xal_services::file_tools::ReadRequest {
        path: request.path,
        display_path: request.display_path,
        offset: request.offset,
        limit: request.limit,
    })
    .map_err(crate::tool_contracts::io_error)?;
    Ok(AsyncTask::new(ReadTask(task)))
}
