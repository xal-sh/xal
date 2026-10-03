use super::*;

#[napi]
pub struct NativeMcpCall {
    pub(super) service: Arc<McpCall>,
    pub(super) runtime: Arc<Runtime>,
}

pub struct ProgressTask {
    service: Arc<McpCall>,
    runtime: Arc<Runtime>,
    cancelled: Arc<AtomicBool>,
}

impl Task for ProgressTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.runtime
            .block_on(self.service.next_progress(&self.cancelled))
            .map_err(failure)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CallResultTask {
    service: Arc<McpCall>,
    runtime: Arc<Runtime>,
    cancelled: Arc<AtomicBool>,
}

impl Task for CallResultTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.runtime
            .block_on(self.service.result(&self.cancelled))
            .map_err(failure)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl NativeMcpCall {
    #[napi(catch_unwind)]
    pub fn next_progress(&self, signal: Option<AbortSignal>) -> AsyncTask<ProgressTask> {
        AsyncTask::new(ProgressTask {
            service: self.service.clone(),
            runtime: self.runtime.clone(),
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn result(&self, signal: Option<AbortSignal>) -> AsyncTask<CallResultTask> {
        AsyncTask::new(CallResultTask {
            service: self.service.clone(),
            runtime: self.runtime.clone(),
            cancelled: cancellation_flag(signal),
        })
    }
}
