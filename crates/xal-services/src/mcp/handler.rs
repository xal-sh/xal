use super::*;

#[derive(Default)]
pub(super) struct ProgressEvent {
    pub(super) progress: f64,
    pub(super) text: String,
}

#[derive(Default)]
pub(super) struct ProgressRoutes {
    pub(super) senders: HashMap<String, mpsc::SyncSender<ProgressEvent>>,
    pending: VecDeque<(String, ProgressEvent)>,
}

impl ProgressRoutes {
    pub(super) fn register(&mut self, key: String, sender: mpsc::SyncSender<ProgressEvent>) {
        let mut pending = VecDeque::new();
        for (token, event) in self.pending.drain(..) {
            if token == key {
                let _ = sender.try_send(event);
            } else {
                pending.push_back((token, event));
            }
        }
        self.pending = pending;
        self.senders.insert(key, sender);
    }

    fn receive(&mut self, key: String, event: ProgressEvent) {
        if let Some(sender) = self.senders.get(&key) {
            let _ = sender.try_send(event);
            return;
        }
        if self.pending.len() == PROGRESS_CAPACITY {
            self.pending.pop_front();
        }
        self.pending.push_back((key, event));
    }
}

#[derive(Default)]
pub(super) struct HandlerState {
    pub(super) tool_revision: AtomicU64,
    pub(super) resource_revision: AtomicU64,
    pub(super) prompt_revision: AtomicU64,
    pub(super) progress: Mutex<ProgressRoutes>,
    pub(super) cleanup_error: Mutex<Option<String>>,
    pub(super) cleanup_tasks: Mutex<Vec<tokio::task::JoinHandle<io::Result<()>>>>,
}

impl HandlerState {
    pub(super) fn revisions(&self) -> (u64, u64, u64) {
        (
            self.tool_revision.load(Ordering::Relaxed),
            self.resource_revision.load(Ordering::Relaxed),
            self.prompt_revision.load(Ordering::Relaxed),
        )
    }
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
        let key = serde_json::to_string(&params.progress_token).expect("progress token serializes");
        lock(&self.state.progress).receive(
            key,
            ProgressEvent {
                progress: params.progress,
                text: progress_text(&params),
            },
        );
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
