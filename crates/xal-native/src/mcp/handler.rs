use super::*;

#[derive(Default)]
pub(super) struct ProgressEvent {
    pub(super) progress: f64,
    pub(super) text: String,
}

#[derive(Default)]
pub(super) struct HandlerState {
    pub(super) tool_revision: AtomicU64,
    pub(super) resource_revision: AtomicU64,
    pub(super) prompt_revision: AtomicU64,
    pub(super) progress: Mutex<HashMap<String, mpsc::SyncSender<ProgressEvent>>>,
}

#[derive(Clone)]
pub(super) struct Handler {
    pub(super) state: Arc<HandlerState>,
    pub(super) info: ClientInfo,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }

    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        let key = serde_json::to_string(&params.progress_token).unwrap_or_default();
        let sender = lock(&self.state.progress).get(&key).cloned();
        if let Some(sender) = sender {
            let event = ProgressEvent {
                progress: params.progress,
                text: progress_text(&params),
            };
            let _ = sender.try_send(event);
        }
        std::future::ready(())
    }

    fn on_tool_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.tool_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }

    fn on_resource_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.resource_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }

    fn on_prompt_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.prompt_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }
}
