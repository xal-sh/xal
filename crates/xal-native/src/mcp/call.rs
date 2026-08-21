use super::*;

pub(super) async fn await_tool_response(
    mut handle: rmcp::service::RequestHandle<RoleClient>,
    duration: Duration,
    cancelled: &AtomicBool,
) -> napi::Result<ServerResult> {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            response = &mut handle.rx => {
                return response
                    .map_err(|_| failed("MCP tool connection closed"))?
                    .map_err(|error| failed(error.to_string()));
            }
            () = &mut deadline => {
                let _ = handle.cancel(Some("request timeout".to_owned())).await;
                return Err(failed(format!("MCP tool call timed out after {}ms", duration.as_millis())));
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {
                if cancelled.load(Ordering::Relaxed) {
                    let _ = handle.cancel(Some("request cancelled".to_owned())).await;
                    return Err(failed("MCP tool call was cancelled"));
                }
            }
        }
    }
}
#[derive(Deserialize)]
pub(super) struct ToolCallRequest {
    pub(super) server: String,
    pub(super) name: String,
    pub(super) arguments: Map<String, Value>,
}
pub(super) struct ProgressReceiver {
    pub(super) receiver: mpsc::Receiver<ProgressEvent>,
    pub(super) pending: VecDeque<ProgressEvent>,
}

pub(super) struct CallShared {
    pub(super) progress: Mutex<ProgressReceiver>,
    pub(super) result: Mutex<Option<mpsc::Receiver<Result<String, String>>>>,
    pub(super) cancelled: AtomicBool,
}

#[napi]
pub struct NativeMcpCall {
    pub(super) shared: Arc<CallShared>,
}

pub struct ProgressTask {
    shared: Arc<CallShared>,
    cancelled: Arc<AtomicBool>,
}

impl Task for ProgressTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(failed("MCP progress wait was cancelled"));
            }
            let mut progress = lock(&self.shared.progress);
            if let Some(event) = progress.pending.pop_front() {
                return Ok(Some(event.text));
            }
            let first = match progress.receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            };
            let mut batch = vec![first];
            while let Ok(event) = progress.receiver.recv_timeout(Duration::from_millis(2)) {
                batch.push(event);
            }
            batch.sort_by(|left, right| left.progress.total_cmp(&right.progress));
            progress.pending.extend(batch);
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CallResultTask {
    shared: Arc<CallShared>,
    cancelled: Arc<AtomicBool>,
}

impl Task for CallResultTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let receiver = lock(&self.shared.result)
            .take()
            .ok_or_else(|| failed("MCP tool result was already collected"))?;
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                self.shared.cancelled.store(true, Ordering::Relaxed);
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(output)) => return Ok(output),
                Ok(Err(error)) => return Err(failed(error)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failed("MCP tool call ended without a result"));
                }
            }
        }
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
            shared: self.shared.clone(),
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn result(&self, signal: Option<AbortSignal>) -> AsyncTask<CallResultTask> {
        AsyncTask::new(CallResultTask {
            shared: self.shared.clone(),
            cancelled: cancellation_flag(signal),
        })
    }
}
