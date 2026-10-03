use super::*;

pub struct ManagerTask {
    pub(super) service: McpManager,
    pub(super) runtime: Arc<Runtime>,
    pub(super) operation: ManagerOperation,
    pub(super) cancelled: Arc<AtomicBool>,
}

pub(super) enum ManagerOperation {
    ConnectAll,
    Reconnect(Option<String>),
    Remove(String),
    Refresh,
    Close,
    ReadResource(String),
    GetPrompt(String),
}

impl Task for ManagerTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.runtime.block_on(async {
            match &self.operation {
                ManagerOperation::ConnectAll => {
                    match self.service.connect_all(self.cancelled.clone()).await {
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => Ok(None),
                        result => result.map(|()| None).map_err(failure),
                    }
                }
                ManagerOperation::Reconnect(server) => self
                    .service
                    .reconnect(server.as_deref(), self.cancelled.clone())
                    .await
                    .map(|()| None)
                    .map_err(failure),
                ManagerOperation::Remove(server) => self
                    .service
                    .remove(server)
                    .await
                    .map(|()| None)
                    .map_err(failure),
                ManagerOperation::Refresh => self
                    .service
                    .refresh(self.cancelled.clone())
                    .await
                    .map(|()| None)
                    .map_err(failure),
                ManagerOperation::Close => {
                    self.service.close().await.map(|()| None).map_err(failure)
                }
                ManagerOperation::ReadResource(request) => self
                    .service
                    .read_resource(parse::<ResourceRequest>(request)?, &self.cancelled)
                    .await
                    .map(Some)
                    .map_err(failure),
                ManagerOperation::GetPrompt(request) => self
                    .service
                    .get_prompt(parse::<PromptRequest>(request)?, &self.cancelled)
                    .await
                    .map(Some)
                    .map_err(failure),
            }
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}
