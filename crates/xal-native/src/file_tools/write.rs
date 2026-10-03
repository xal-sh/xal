use super::*;

#[napi(object)]
pub struct NativeWriteRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub content: Option<Utf16String>,
    pub expected: Option<String>,
}

pub struct WriteTask(xal_services::file_tools::WriteTask);

impl Task for WriteTask {
    type Output = xal_services::file_tools::FileToolOutput;
    type JsValue = NativeFileToolOutput;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(js_name = "nativeWriteFile", catch_unwind)]
pub fn native_write_file(request: NativeWriteRequest) -> napi::Result<AsyncTask<WriteTask>> {
    let task = xal_services::file_tools::write_file(xal_services::file_tools::WriteRequest {
        path: request.path,
        display_path: request.display_path,
        content: request.content.map(|value| value.to_vec()),
        expected: request.expected,
    })
    .map_err(crate::tool_contracts::io_error)?;
    Ok(AsyncTask::new(WriteTask(task)))
}
