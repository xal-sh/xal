#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicU64},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::process::{
    NativeEnvironmentVariable, NativeProcessRequest, NativeProcessTermination, ProcessState,
    process_clear_timeout, process_drain, process_output_closed, process_reader_error,
    process_set_timeout, process_signal, process_termination, process_timed_out, process_write,
    spawn_process,
};

const OUTPUT_CAPACITY: usize = 256 * 1024;
static MARKER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct RunOutput {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

struct RunState {
    output: Mutex<RunOutput>,
    output_changed: Condvar,
    completion: Mutex<Option<Result<NativeProcessTermination, String>>>,
    completed: Condvar,
    process: Arc<ProcessState>,
}

impl RunState {
    fn new(process: Arc<ProcessState>) -> Arc<Self> {
        Arc::new(Self {
            output: Mutex::new(RunOutput {
                chunks: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            output_changed: Condvar::new(),
            completion: Mutex::new(None),
            completed: Condvar::new(),
            process,
        })
    }

    fn push(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let mut output = lock(&self.output);
        while !output.closed && output.bytes + bytes.len() > OUTPUT_CAPACITY {
            output = self
                .output_changed
                .wait(output)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if output.closed {
            return;
        }
        output.bytes += bytes.len();
        output.chunks.push_back(bytes);
    }

    fn finish(&self, termination: NativeProcessTermination) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
        *completion = Some(Ok(termination));
        drop(completion);
        self.completed.notify_all();
    }

    fn fail(&self, error: String) {
        let mut completion = lock(&self.completion);
        if completion.is_some() {
            return;
        }
        *completion = Some(Err(error));
        drop(completion);
        self.completed.notify_all();
    }

    fn done(&self) -> bool {
        lock(&self.completion).is_some()
    }
}

struct ActiveRun {
    state: Arc<RunState>,
    needle: Vec<u8>,
    holdback: usize,
    pending: Vec<u8>,
}

struct PersistentEntry {
    process: Arc<ProcessState>,
    workspace: String,
    active: Mutex<Option<ActiveRun>>,
    dead: AtomicBool,
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

fn feed_active(entry: &PersistentEntry, bytes: Vec<u8>) {
    let mut active = lock(&entry.active);
    let Some(run) = active.as_mut() else {
        return;
    };
    run.pending.extend(bytes);
    let Some(found) = find_bytes(&run.pending, &run.needle) else {
        let emit = run.pending.len().saturating_sub(run.holdback);
        if emit > 0 {
            run.state.push(run.pending.drain(..emit).collect());
        }
        return;
    };
    let status_start = found + run.needle.len();
    let Some(relative_end) = run.pending[status_start..]
        .iter()
        .position(|byte| *byte == b'\n')
    else {
        return;
    };
    let line_end = status_start + relative_end;
    if found > 0 {
        run.state.push(run.pending[..found].to_vec());
    }
    let status = std::str::from_utf8(&run.pending[status_start..line_end])
        .ok()
        .and_then(|value| value.parse::<i32>().ok());
    let state = run.state.clone();
    *active = None;
    state.finish(match status {
        Some(exit_code) => NativeProcessTermination {
            status: "exited".to_owned(),
            exit_code: Some(exit_code),
            signal: None,
        },
        None => NativeProcessTermination {
            status: "signaled".to_owned(),
            exit_code: None,
            signal: None,
        },
    });
}

fn close_active(entry: &PersistentEntry, termination: NativeProcessTermination) {
    let active = lock(&entry.active).take();
    let Some(mut run) = active else {
        return;
    };
    if !run.pending.is_empty() {
        run.state.push(std::mem::take(&mut run.pending));
    }
    run.state.finish(termination);
}

fn fail_active(entry: &PersistentEntry, error: String) {
    let active = lock(&entry.active).take();
    if let Some(run) = active {
        run.state.fail(error);
    }
}

fn dispatch_persistent(entry: Arc<PersistentEntry>) {
    loop {
        let bytes = process_drain(&entry.process);
        if !bytes.is_empty() {
            feed_active(&entry, bytes);
        }
        if let Some(termination) = process_termination(&entry.process)
            && process_output_closed(&entry.process)
        {
            let remaining = process_drain(&entry.process);
            if !remaining.is_empty() {
                feed_active(&entry, remaining);
            }
            entry.dead.store(true, std::sync::atomic::Ordering::Release);
            if let Some(error) = process_reader_error(&entry.process) {
                fail_active(
                    &entry,
                    format!("could not read native process output: {error}"),
                );
            } else {
                close_active(&entry, termination);
            }
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn dispatch_isolated(process: Arc<ProcessState>, run: Arc<RunState>) {
    loop {
        let bytes = process_drain(&process);
        if !bytes.is_empty() {
            run.push(bytes);
        }
        if let Some(termination) = process_termination(&process)
            && process_output_closed(&process)
        {
            let remaining = process_drain(&process);
            if !remaining.is_empty() {
                run.push(remaining);
            }
            if let Some(error) = process_reader_error(&process) {
                run.fail(format!("could not read native process output: {error}"));
            } else if termination.status == "launchFailed" {
                run.fail(
                    termination
                        .signal
                        .unwrap_or_else(|| "native shell launch failed".to_owned()),
                );
            } else {
                run.finish(termination);
            }
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn marker() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = MARKER_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("__xal_{}_{stamp}_{sequence}__", std::process::id())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[napi(object)]
pub struct NativeShellRequest {
    pub session_id: String,
    pub sandbox_id: String,
    pub command: String,
    pub cwd: String,
    pub persistent_launch: Vec<String>,
    pub isolated_launch: Vec<String>,
    pub environment: Vec<NativeEnvironmentVariable>,
}

#[napi]
pub struct NativeShellExecution {
    state: Arc<RunState>,
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
        self.state.output_changed.notify_all();
        bytes.into()
    }

    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        self.state.done()
    }

    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitShellTask> {
        AsyncTask::new(WaitShellTask {
            state: self.state.clone(),
        })
    }

    #[napi(catch_unwind)]
    pub fn set_timeout(&self, milliseconds: u32) {
        process_set_timeout(&self.state.process, milliseconds);
    }

    #[napi(catch_unwind)]
    pub fn clear_timeout(&self) {
        process_clear_timeout(&self.state.process);
    }

    #[napi(catch_unwind)]
    pub fn timed_out(&self) -> bool {
        process_timed_out(&self.state.process)
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

#[napi]
pub struct NativeShellManager {
    entries: Arc<Mutex<HashMap<String, Arc<PersistentEntry>>>>,
}

#[napi]
impl NativeShellManager {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[napi(catch_unwind)]
    pub fn execute(&self, request: NativeShellRequest) -> napi::Result<NativeShellExecution> {
        if request.session_id.is_empty() || request.sandbox_id.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "native shell identity is required".to_owned(),
            ));
        }
        if request.cwd.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "native shell cwd is required".to_owned(),
            ));
        }
        let key = format!("{}\0{}", request.session_id, request.sandbox_id);
        let mut entries = lock(&self.entries);
        let mut entry = entries.get(&key).cloned();
        if entry
            .as_ref()
            .is_some_and(|entry| entry.dead.load(std::sync::atomic::Ordering::Acquire))
        {
            entries.remove(&key);
            entry = None;
        }
        if entry
            .as_ref()
            .is_some_and(|entry| lock(&entry.active).is_some())
        {
            drop(entries);
            return self.execute_isolated(request);
        }
        if entry
            .as_ref()
            .is_some_and(|entry| entry.workspace != request.cwd)
        {
            if let Some(previous) = entries.remove(&key) {
                process_signal(&previous.process, true);
            }
            entry = None;
        }
        let entry = match entry {
            Some(entry) => entry,
            None => {
                let process = spawn_process(NativeProcessRequest {
                    launch: request.persistent_launch,
                    cwd: request.cwd.clone(),
                    environment: request.environment,
                    stdin: true,
                })?;
                let entry = Arc::new(PersistentEntry {
                    process,
                    workspace: request.cwd,
                    active: Mutex::new(None),
                    dead: AtomicBool::new(false),
                });
                entries.insert(key, entry.clone());
                let dispatcher = entry.clone();
                thread::spawn(move || dispatch_persistent(dispatcher));
                entry
            }
        };
        drop(entries);
        let marker = marker();
        let needle = format!("\n{marker}:").into_bytes();
        let state = RunState::new(entry.process.clone());
        *lock(&entry.active) = Some(ActiveRun {
            state: state.clone(),
            holdback: needle.len() + 16,
            needle,
            pending: Vec::new(),
        });
        let framed = format!(
            "{{ eval {}; }} </dev/null 2>&1\nprintf '\\n%s:%s\\n' {} \"$?\"\n",
            shell_quote(&request.command),
            shell_quote(&marker)
        );
        if let Err(error) = process_write(&entry.process, framed.as_bytes()) {
            *lock(&entry.active) = None;
            state.fail(error.reason);
        }
        Ok(NativeShellExecution { state })
    }

    fn execute_isolated(&self, request: NativeShellRequest) -> napi::Result<NativeShellExecution> {
        let process = spawn_process(NativeProcessRequest {
            launch: request.isolated_launch,
            cwd: request.cwd,
            environment: request.environment,
            stdin: false,
        })?;
        let state = RunState::new(process.clone());
        let dispatcher = state.clone();
        thread::spawn(move || dispatch_isolated(process, dispatcher));
        Ok(NativeShellExecution { state })
    }

    #[napi(catch_unwind)]
    pub fn dispose_session(&self, session_id: String) {
        let prefix = format!("{session_id}\0");
        let removed = {
            let mut entries = lock(&self.entries);
            let keys = entries
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .collect::<Vec<_>>()
        };
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }

    #[napi(catch_unwind)]
    pub fn dispose_all(&self) {
        let removed = {
            let mut entries = lock(&self.entries);
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }
}

impl Drop for NativeShellExecution {
    fn drop(&mut self) {
        let mut output = lock(&self.state.output);
        output.closed = true;
        self.state.output_changed.notify_all();
    }
}

impl Drop for NativeShellManager {
    fn drop(&mut self) {
        let removed = {
            let mut entries = lock(&self.entries);
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }
}
