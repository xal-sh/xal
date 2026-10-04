use super::*;

pub(super) async fn await_response(
    mut handle: rmcp::service::RequestHandle<RoleClient>,
    duration: Duration,
    cancelled: &AtomicBool,
    label: &str,
) -> io::Result<ServerResult> {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    let error = loop {
        if cancelled.load(Ordering::Relaxed) {
            break Error::new(io::ErrorKind::Interrupted, format!("{label} was cancelled"));
        }
        tokio::select! {
            response = &mut handle.rx => {
                return response
                    .map_err(|_| failed(format!("{label} connection closed")))?
                    .map_err(|error| failed(error.to_string()));
            }
            () = &mut deadline => {
                break Error::new(io::ErrorKind::TimedOut, format!("{label} timed out after {}ms", duration.as_millis()));
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    };
    match tokio::time::timeout(
        Duration::from_secs(1),
        handle.cancel(Some(error.to_string())),
    )
    .await
    {
        Ok(Ok(())) => Err(error),
        Ok(Err(cancel)) => Err(Error::new(
            error.kind(),
            format!("{error}; cancellation notification failed: {cancel}"),
        )),
        Err(_) => Err(Error::new(
            error.kind(),
            format!("{error}; cancellation notification timed out"),
        )),
    }
}

#[derive(Clone, Debug)]
pub struct ToolCallRequest {
    pub server: String,
    pub name: String,
    pub arguments: Map<String, Value>,
}

pub(super) struct ProgressReceiver {
    pub(super) receiver: mpsc::Receiver<ProgressEvent>,
    pub(super) pending: VecDeque<ProgressEvent>,
}

pub(super) struct CallShared {
    pub(super) progress: Mutex<ProgressReceiver>,
    pub(super) result: Mutex<Option<mpsc::Receiver<io::Result<String>>>>,
    pub(super) cancelled: AtomicBool,
}

pub(super) struct OwnedCall {
    pub(super) shared: Arc<CallShared>,
    pub(super) task: tokio::task::JoinHandle<()>,
}

pub struct McpCall {
    pub(super) shared: Arc<CallShared>,
}

impl McpCall {
    pub fn cancel(&self) {
        self.shared.cancelled.store(true, Ordering::Relaxed);
    }

    pub async fn next_progress(&self, cancelled: &AtomicBool) -> io::Result<Option<String>> {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    io::ErrorKind::Interrupted,
                    "MCP progress wait was cancelled",
                ));
            }
            {
                let mut progress = lock(&self.shared.progress);
                if let Some(event) = progress.pending.pop_front() {
                    return Ok(Some(event.text));
                }
                let mut batch = Vec::new();
                for _ in 0..PROGRESS_CAPACITY {
                    match progress.receiver.try_recv() {
                        Ok(event) => batch.push(event),
                        Err(mpsc::TryRecvError::Disconnected) if batch.is_empty() => {
                            return Ok(None);
                        }
                        Err(_) => break,
                    }
                }
                batch.sort_by(|left, right| left.progress.total_cmp(&right.progress));
                progress.pending.extend(batch);
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    pub async fn result(&self, cancelled: &AtomicBool) -> io::Result<String> {
        let receiver = lock(&self.shared.result)
            .take()
            .ok_or_else(|| failed("MCP tool result was already collected"))?;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                self.cancel();
            }
            match receiver.try_recv() {
                Ok(result) => return result,
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(failed("MCP tool call ended without a result"));
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for McpCall {
    fn drop(&mut self) {
        self.cancel();
    }
}
