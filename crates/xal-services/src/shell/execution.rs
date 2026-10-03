use super::*;

struct RunOutput {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

pub(super) struct RunState {
    output: Mutex<RunOutput>,
    output_changed: Condvar,
    completion: Mutex<Option<Result<ProcessTermination, String>>>,
    completed: Condvar,
    deadline: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    process: Arc<ProcessState>,
}

impl RunState {
    pub(super) fn new(process: Arc<ProcessState>) -> Arc<Self> {
        Arc::new(Self {
            output: Mutex::new(RunOutput {
                chunks: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            output_changed: Condvar::new(),
            completion: Mutex::new(None),
            completed: Condvar::new(),
            deadline: Mutex::new(None),
            timed_out: AtomicBool::new(false),
            process,
        })
    }

    pub(super) fn push(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let mut output = lock(&self.output);
        if output.bytes.saturating_add(bytes.len()) > OUTPUT_CAPACITY {
            output.closed = true;
            drop(output);
            self.fail("shell output exceeded 64 MiB without being drained".into());
            process_signal(&self.process, true);
            return;
        }
        if output.closed {
            return;
        }
        output.bytes += bytes.len();
        output.chunks.push_back(bytes);
    }

    pub(super) fn finish(&self, termination: ProcessTermination) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
        *completion = Some(Ok(termination));
        drop(completion);
        self.completed.notify_all();
    }

    pub(super) fn fail(&self, error: String) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
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

pub struct ShellExecution {
    pub(super) state: Arc<RunState>,
}

pub struct WaitShellTask {
    state: Arc<RunState>,
}

impl WaitShellTask {
    pub fn compute(&mut self) -> std::io::Result<ProcessTermination> {
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
            Some(Err(error)) => Err(Error::other(error)),
            None => Err(Error::other(
                "native shell termination was unavailable".to_owned(),
            )),
        }
    }
}

impl ShellExecution {
    pub fn drain(&self) -> Vec<u8> {
        let mut output = lock(&self.state.output);
        let mut bytes = Vec::with_capacity(output.bytes);
        while let Some(chunk) = output.chunks.pop_front() {
            bytes.extend(chunk);
        }
        output.bytes = 0;
        self.state.output_changed.notify_all();
        bytes
    }

    pub fn output_closed(&self) -> bool {
        self.state.done()
    }

    pub fn wait(&self) -> WaitShellTask {
        WaitShellTask {
            state: self.state.clone(),
        }
    }

    pub fn set_timeout(&self, milliseconds: u32) {
        self.state.set_timeout(milliseconds);
    }

    pub fn clear_timeout(&self) {
        self.state.clear_timeout();
    }

    pub fn timed_out(&self) -> bool {
        self.state.timed_out()
    }

    pub fn terminate(&self) {
        process_signal(&self.state.process, false);
    }

    pub fn kill(&self) {
        process_signal(&self.state.process, true);
    }
}
impl Drop for ShellExecution {
    fn drop(&mut self) {
        let mut output = lock(&self.state.output);
        output.closed = true;
        self.state.output_changed.notify_all();
        drop(output);
        if !self.state.done() {
            process_signal(&self.state.process, true);
        }
    }
}
