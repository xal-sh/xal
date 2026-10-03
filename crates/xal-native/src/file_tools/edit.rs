use super::*;

#[napi(object)]
pub struct NativeEditRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub old_string: Option<Utf16String>,
    pub new_string: Option<Utf16String>,
    pub replace_all: Option<bool>,
    pub expected: Option<String>,
}

pub struct EditTask(xal_services::file_tools::EditTask);

impl Task for EditTask {
    type Output = xal_services::file_tools::FileToolOutput;
    type JsValue = NativeFileToolOutput;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(crate::tool_contracts::io_error)
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(request: NativeEditRequest) -> napi::Result<AsyncTask<EditTask>> {
    let task = xal_services::file_tools::edit_file(xal_services::file_tools::EditRequest {
        path: request.path,
        display_path: request.display_path,
        old_string: request.old_string.map(|value| value.to_vec()),
        new_string: request.new_string.map(|value| value.to_vec()),
        replace_all: request.replace_all,
        expected: request.expected,
    })
    .map_err(crate::tool_contracts::io_error)?;
    Ok(AsyncTask::new(EditTask(task)))
}
