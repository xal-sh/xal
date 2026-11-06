use super::*;

struct RunOutput {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
    lossy: bool,
    dropped: bool,
}

pub(super) struct RunState {
    output: Mutex<RunOutput>,
    output_changed: Condvar,
    completion: Mutex<Option<Result<NativeProcessTermination, String>>>,
    completed: Condvar,
    deadline: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    process: Arc<ProcessState>,
    initial_dropped_bytes: u64,
    process_dropped: AtomicBool,
}

impl RunState {
    pub(super) fn new(process: Arc<ProcessState>) -> Arc<Self> {
        Arc::new(Self {
            output: Mutex::new(RunOutput {
                chunks: VecDeque::new(),
                bytes: 0,
                closed: false,
                lossy: false,
                dropped: false,
            }),
            output_changed: Condvar::new(),
            completion: Mutex::new(None),
            completed: Condvar::new(),
            deadline: Mutex::new(None),
            timed_out: AtomicBool::new(false),
            initial_dropped_bytes: crate::process::process_dropped_bytes(&process),
            process_dropped: AtomicBool::new(false),
            process,
        })
    }

    pub(super) fn push(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let mut output = lock(&self.output);
        let bytes = if bytes.len() > OUTPUT_CAPACITY {
            output.dropped = true;
            bytes[bytes.len() - OUTPUT_CAPACITY..].to_vec()
        } else {
            bytes
        };
        while !output.closed && output.bytes + bytes.len() > OUTPUT_CAPACITY {
            if output.lossy {
                let Some(dropped) = output.chunks.pop_front() else {
                    break;
                };
                output.bytes -= dropped.len();
                output.dropped = true;
                continue;
            }
            let (next, timeout) = self
                .output_changed
                .wait_timeout(output, Duration::from_millis(100))
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            output = next;
            output.lossy = timeout.timed_out();
        }
        if output.closed {
            return;
        }
        output.bytes += bytes.len();
        output.chunks.push_back(bytes);
    }

    pub(super) fn finish(&self, termination: NativeProcessTermination) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
        self.process_dropped.store(
            crate::process::process_dropped_bytes(&self.process) > self.initial_dropped_bytes,
            std::sync::atomic::Ordering::Relaxed,
        );
        *completion = Some(Ok(termination));
        drop(completion);
        self.completed.notify_all();
    }

    pub(super) fn fail(&self, error: String) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
        self.process_dropped.store(
            crate::process::process_dropped_bytes(&self.process) > self.initial_dropped_bytes,
            std::sync::atomic::Ordering::Relaxed,
        );
        *completion = Some(Err(error));
        drop(completion);
        self.completed.notify_all();
    }

    pub(super) fn done(&self) -> bool {
        lock(&self.completion).is_some()
    }

    pub(super) fn set_timeout(&self, milliseconds: u32) {
        *lock(&self.deadline) =
            Some(Instant::now() + Duration::from_millis(u64::from(milliseconds)));
    }

    pub(super) fn clear_timeout(&self) {
        *lock(&self.deadline) = None;
    }

    pub(super) fn timed_out(&self) -> bool {
        self.timed_out.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn expire(&self) -> bool {
        let mut deadline = lock(&self.deadline);
        if deadline.is_none_or(|deadline| Instant::now() < deadline) {
            return false;
        }
        *deadline = None;
        self.timed_out
            .store(true, std::sync::atomic::Ordering::Relaxed);
        true
    }
}
#[napi]
pub struct NativeShellExecution {
    pub(super) state: Arc<RunState>,
}

pub struct WaitShellTask {
    state: Arc<RunState>,
}

impl Task for WaitShellTask {
    type Output = NativeProcessTermination;
    type JsValue = NativeProcessTermination;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let mut completion = lock(&self.state.completion);
        while completion.is_none() {
            completion = self
                .state
                .completed
                .wait(completion)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        match completion.clone() {
            Some(Ok(termination)) => Ok(termination),
            Some(Err(error)) => Err(Error::new(Status::GenericFailure, error)),
            None => Err(Error::new(
                Status::GenericFailure,
                "native shell termination was unavailable".to_owned(),
            )),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl NativeShellExecution {
    #[napi(catch_unwind)]
    pub fn drain(&self) -> Buffer {
        let mut output = lock(&self.state.output);
        let mut bytes = Vec::with_capacity(output.bytes);
        while let Some(chunk) = output.chunks.pop_front() {
            bytes.extend(chunk);
        }
        output.bytes = 0;
        output.lossy = false;
        self.state.output_changed.notify_all();
        bytes.into()
    }

    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        self.state.done()
    }

    #[napi(catch_unwind)]
    pub fn output_dropped(&self) -> bool {
        let process_dropped = if self.state.done() {
            self.state
                .process_dropped
                .load(std::sync::atomic::Ordering::Relaxed)
        } else {
            crate::process::process_dropped_bytes(&self.state.process)
                > self.state.initial_dropped_bytes
        };
        lock(&self.state.output).dropped || process_dropped
    }

    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitShellTask> {
        AsyncTask::new(WaitShellTask {
            state: self.state.clone(),
        })
    }

    #[napi(catch_unwind)]
    pub fn set_timeout(&self, milliseconds: u32) {
        self.state.set_timeout(milliseconds);
    }

    #[napi(catch_unwind)]
    pub fn clear_timeout(&self) {
        self.state.clear_timeout();
    }

    #[napi(catch_unwind)]
    pub fn timed_out(&self) -> bool {
        self.state.timed_out()
    }

    #[napi(catch_unwind)]
    pub fn terminate(&self) {
        process_signal(&self.state.process, false);
    }

    #[napi(catch_unwind)]
    pub fn kill(&self) {
        process_signal(&self.state.process, true);
    }
}
impl Drop for NativeShellExecution {
    fn drop(&mut self) {
        let mut output = lock(&self.state.output);
        output.closed = true;
        self.state.output_changed.notify_all();
    }
}
