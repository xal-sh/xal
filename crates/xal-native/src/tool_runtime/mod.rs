use napi_derive::napi;
use xal_services::tool_runtime::*;

fn run(
    request: String,
    handler: fn(&serde_json::Value) -> std::io::Result<serde_json::Value>,
) -> napi::Result<String> {
    xal_services::tool_runtime::run(request, handler)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.to_string()))
}

#[napi]
pub struct NativeToolRuntime;

#[napi]
impl NativeToolRuntime {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self
    }

    #[napi(catch_unwind)]
    pub fn job_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_process_output(&self, request: String) -> napi::Result<String> {
        run(request, process_output)
    }
    #[napi(catch_unwind)]
    pub fn job_agent_output(&self, request: String) -> napi::Result<String> {
        run(request, agent_output)
    }
    #[napi(catch_unwind)]
    pub fn job_kill(&self, request: String) -> napi::Result<String> {
        run(request, job_kill)
    }
    #[napi(catch_unwind)]
    pub fn job_status(&self, request: String) -> napi::Result<String> {
        run(request, job_status)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_extend_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_extend_finalize)
    }
    #[napi(catch_unwind)]
    pub fn job_send_prepare(&self, request: String) -> napi::Result<String> {
        run(request, job_send_prepare)
    }
    #[napi(catch_unwind)]
    pub fn job_send_finalize(&self, request: String) -> napi::Result<String> {
        run(request, job_send_finalize)
    }
    #[napi(catch_unwind)]
    pub fn task_prepare(&self, request: String) -> napi::Result<String> {
        run(request, task_prepare)
    }
    #[napi(catch_unwind)]
    pub fn task_context(&self, request: String) -> napi::Result<String> {
        run(request, task_context)
    }
    #[napi(catch_unwind)]
    pub fn task_items(&self, request: String) -> napi::Result<String> {
        run(request, task_items)
    }
    #[napi(catch_unwind)]
    pub fn task_finalize(&self, request: String) -> napi::Result<String> {
        run(request, task_finalize)
    }
    #[napi(catch_unwind)]
    pub fn scheduler_prepare(&self, request: String) -> napi::Result<String> {
        run(request, scheduler_prepare)
    }
    #[napi(catch_unwind)]
    pub fn scheduler_finalize(&self, request: String) -> napi::Result<String> {
        run(request, scheduler_finalize)
    }
    #[napi(catch_unwind)]
    pub fn update_plan(&self, request: String) -> napi::Result<String> {
        run(request, update_plan)
    }
    #[napi(catch_unwind)]
    pub fn request_input_prepare(&self, request: String) -> napi::Result<String> {
        run(request, request_input_prepare)
    }
    #[napi(catch_unwind)]
    pub fn request_input_finalize(&self, request: String) -> napi::Result<String> {
        run(request, request_input_finalize)
    }
    #[napi(catch_unwind)]
    pub fn memory_prepare(&self, request: String) -> napi::Result<String> {
        run(request, memory_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_prepare(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_prepare)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_review(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_review)
    }
    #[napi(catch_unwind)]
    pub fn submit_plan_finalize(&self, request: String) -> napi::Result<String> {
        run(request, submit_plan_finalize)
    }
}
