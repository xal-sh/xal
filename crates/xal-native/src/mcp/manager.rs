use super::*;

#[napi]
pub struct NativeMcpManager {
    service: McpManager,
    runtime: Arc<Runtime>,
}

#[napi]
impl NativeMcpManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(configs: String, app_name: String, app_version: String) -> napi::Result<Self> {
        Ok(Self {
            service: McpManager::new(parse(&configs)?, app_name, app_version).map_err(failure)?,
            runtime: Arc::new(
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .map_err(failure)?,
            ),
        })
    }

    fn task(
        &self,
        operation: ManagerOperation,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        AsyncTask::new(ManagerTask {
            service: self.service.clone(),
            runtime: self.runtime.clone(),
            operation,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn connect_all(&self, signal: Option<AbortSignal>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ConnectAll, signal)
    }

    #[napi(catch_unwind)]
    pub fn reconnect(&self, server: Option<String>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Reconnect(server), None)
    }

    #[napi(catch_unwind)]
    pub fn remove(&self, server: String) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Remove(server), None)
    }

    #[napi(catch_unwind)]
    pub fn refresh(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Refresh, None)
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Close, None)
    }

    #[napi(catch_unwind)]
    pub fn servers(&self) -> napi::Result<String> {
        serde_json::to_string(&self.service.servers()).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, server: Option<String>) -> Vec<String> {
        self.service.status_lines(server.as_deref())
    }

    #[napi(getter, catch_unwind)]
    pub fn has_resources(&self) -> bool {
        self.service.has_resources()
    }

    #[napi(getter, catch_unwind)]
    pub fn has_prompts(&self) -> bool {
        self.service.has_prompts()
    }

    #[napi(catch_unwind)]
    pub fn instructions(&self, server: String) -> String {
        self.service.instructions(&server)
    }

    #[napi(catch_unwind)]
    pub fn resource_catalog(&self, server: Option<String>) -> napi::Result<String> {
        self.service
            .resource_catalog(server.as_deref())
            .map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn prompt_catalog(&self, server: Option<String>) -> napi::Result<String> {
        self.service
            .prompt_catalog(server.as_deref())
            .map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn read_resource(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ReadResource(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn get_prompt(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::GetPrompt(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn tool_descriptors(&self) -> napi::Result<String> {
        serde_json::to_string(&self.service.tool_descriptors()).map_err(failure)
    }

    #[napi(catch_unwind)]
    pub fn start_tool_call(&self, request: String) -> napi::Result<NativeMcpCall> {
        let _runtime = self.runtime.enter();
        Ok(NativeMcpCall {
            service: Arc::new(
                self.service
                    .start_tool_call(parse::<ToolCallRequest>(&request)?)
                    .map_err(failure)?,
            ),
            runtime: self.runtime.clone(),
        })
    }
}
