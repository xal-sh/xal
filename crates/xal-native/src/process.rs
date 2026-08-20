#![cfg_attr(test, allow(dead_code))]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicUsize},
};
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AsyncTask, Buffer, Utf16String};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

const OUTPUT_CAPACITY: usize = 256 * 1024;

#[napi(object)]
pub struct NativeEnvironmentVariable {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct NativeProcessRequest {
    pub launch: Vec<String>,
    pub cwd: String,
    pub environment: Vec<NativeEnvironmentVariable>,
    pub stdin: bool,
}

#[napi(object)]
pub struct NativeProcessTermination {
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

struct OutputQueue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

pub(crate) struct ProcessState {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    output: Mutex<OutputQueue>,
    output_changed: Condvar,
    readers: AtomicUsize,
    reader_error: Mutex<Option<String>>,
    termination: Mutex<Option<NativeProcessTermination>>,
    terminated: Condvar,
    deadline: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    pid: u32,
}

fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn push_output(state: &ProcessState, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let mut output = lock(&state.output);
    while !output.closed && output.bytes + bytes.len() > OUTPUT_CAPACITY {
        output = state
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

fn read_stream(state: Arc<ProcessState>, mut stream: impl Read) {
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => push_output(&state, buffer[..read].to_vec()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let mut reader_error = lock(&state.reader_error);
                if reader_error.is_none() {
                    *reader_error = Some(error.to_string());
                }
                break;
            }
        }
    }
    state
        .readers
        .fetch_sub(1, std::sync::atomic::Ordering::Release);
    state.output_changed.notify_all();
}

#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            4 => "SIGILL",
            6 => "SIGABRT",
            8 => "SIGFPE",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            14 => "SIGALRM",
            15 => "SIGTERM",
            _ => return signal.to_string(),
        }
        .to_owned()
    })
}

#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

fn watch_process(state: Arc<ProcessState>) {
    let status = loop {
        let timed_out = lock(&state.deadline).is_some_and(|deadline| Instant::now() >= deadline);
        if timed_out {
            *lock(&state.deadline) = None;
            state
                .timed_out
                .store(true, std::sync::atomic::Ordering::Relaxed);
            signal_process_tree(&state, true);
        }
        let result = {
            let mut child = lock(&state.child);
            let Some(child) = child.as_mut() else {
                return;
            };
            child.try_wait()
        };
        match result {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => break Err(error),
        }
    };
    let termination = match status {
        Ok(status) => match status.code() {
            Some(exit_code) => NativeProcessTermination {
                status: "exited".to_owned(),
                exit_code: Some(exit_code),
                signal: None,
            },
            None => NativeProcessTermination {
                status: "signaled".to_owned(),
                exit_code: None,
                signal: signal_name(&status),
            },
        },
        Err(error) => NativeProcessTermination {
            status: "launchFailed".to_owned(),
            exit_code: None,
            signal: Some(error.to_string()),
        },
    };
    *lock(&state.stdin) = None;
    *lock(&state.termination) = Some(termination);
    state.terminated.notify_all();
}

fn signal_process_tree(state: &ProcessState, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let _ = Command::new("kill")
            .args([signal, "--", &format!("-{}", state.pid)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &state.pid.to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    if force && let Some(child) = lock(&state.child).as_mut() {
        let _ = child.kill();
    }
}

pub(crate) fn spawn_process(request: NativeProcessRequest) -> napi::Result<Arc<ProcessState>> {
    let executable = request
        .launch
        .first()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(Status::InvalidArg, "process launch is required".to_owned()))?;
    if request.cwd.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "process cwd is required".to_owned(),
        ));
    }
    let mut command = Command::new(executable);
    command
        .args(&request.launch[1..])
        .current_dir(request.cwd)
        .env_clear()
        .envs(
            request
                .environment
                .iter()
                .map(|entry| (&entry.name, &entry.value)),
        )
        .stdin(if request.stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        Error::new(Status::GenericFailure, format!("failed to launch: {error}"))
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "native process stdout was unavailable".to_owned(),
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "native process stderr was unavailable".to_owned(),
        )
    })?;
    let state = Arc::new(ProcessState {
        pid: child.id(),
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(stdin),
        output: Mutex::new(OutputQueue {
            chunks: VecDeque::new(),
            bytes: 0,
            closed: false,
        }),
        output_changed: Condvar::new(),
        readers: AtomicUsize::new(2),
        reader_error: Mutex::new(None),
        termination: Mutex::new(None),
        terminated: Condvar::new(),
        deadline: Mutex::new(None),
        timed_out: AtomicBool::new(false),
    });
    let stdout_state = state.clone();
    thread::spawn(move || read_stream(stdout_state, stdout));
    let stderr_state = state.clone();
    thread::spawn(move || read_stream(stderr_state, stderr));
    let watch_state = state.clone();
    thread::spawn(move || watch_process(watch_state));
    Ok(state)
}

pub(crate) fn process_drain(state: &ProcessState) -> Vec<u8> {
    let mut output = lock(&state.output);
    let mut bytes = Vec::with_capacity(output.bytes);
    while let Some(chunk) = output.chunks.pop_front() {
        bytes.extend(chunk);
    }
    output.bytes = 0;
    state.output_changed.notify_all();
    bytes
}

pub(crate) fn process_output_closed(state: &ProcessState) -> bool {
    state.readers.load(std::sync::atomic::Ordering::Acquire) == 0
}

pub(crate) fn process_termination(state: &ProcessState) -> Option<NativeProcessTermination> {
    lock(&state.termination).clone()
}

pub(crate) fn process_reader_error(state: &ProcessState) -> Option<String> {
    lock(&state.reader_error).clone()
}

pub(crate) fn process_write(state: &ProcessState, bytes: &[u8]) -> napi::Result<()> {
    let mut stdin = lock(&state.stdin);
    let stdin = stdin.as_mut().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "native process stdin is closed".to_owned(),
        )
    })?;
    stdin
        .write_all(bytes)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    stdin
        .flush()
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

pub(crate) fn process_set_timeout(state: &ProcessState, milliseconds: u32) {
    *lock(&state.deadline) = Some(Instant::now() + Duration::from_millis(u64::from(milliseconds)));
}

pub(crate) fn process_clear_timeout(state: &ProcessState) {
    *lock(&state.deadline) = None;
}

pub(crate) fn process_timed_out(state: &ProcessState) -> bool {
    state.timed_out.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn process_signal(state: &ProcessState, force: bool) {
    signal_process_tree(state, force);
}

fn wait_process(state: &ProcessState) -> napi::Result<NativeProcessTermination> {
    let mut termination = lock(&state.termination);
    while termination.is_none() {
        termination = state
            .terminated
            .wait(termination)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    let termination = termination.clone().ok_or_else(|| {
        Error::new(
            Status::GenericFailure,
            "native process termination was unavailable".to_owned(),
        )
    })?;
    let mut output = lock(&state.output);
    while !process_output_closed(state) {
        output = state
            .output_changed
            .wait(output)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    drop(output);
    if let Some(error) = process_reader_error(state) {
        return Err(Error::new(
            Status::GenericFailure,
            format!("could not read native process output: {error}"),
        ));
    }
    Ok(termination)
}

pub struct WaitProcessTask {
    state: Arc<ProcessState>,
}

impl Task for WaitProcessTask {
    type Output = NativeProcessTermination;
    type JsValue = NativeProcessTermination;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        wait_process(&self.state)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

impl Clone for NativeProcessTermination {
    fn clone(&self) -> Self {
        Self {
            status: self.status.clone(),
            exit_code: self.exit_code,
            signal: self.signal.clone(),
        }
    }
}

#[napi]
pub struct NativeProcess {
    state: Arc<ProcessState>,
}

#[napi]
impl NativeProcess {
    #[napi(factory, catch_unwind)]
    pub fn spawn(request: NativeProcessRequest) -> napi::Result<Self> {
        Ok(Self {
            state: spawn_process(request)?,
        })
    }

    #[napi(catch_unwind)]
    pub fn write(&self, bytes: Buffer) -> napi::Result<()> {
        process_write(&self.state, &bytes)
    }

    #[napi(catch_unwind)]
    pub fn close_stdin(&self) {
        *lock(&self.state.stdin) = None;
    }

    #[napi(catch_unwind)]
    pub fn drain(&self) -> Buffer {
        process_drain(&self.state).into()
    }

    #[napi(catch_unwind)]
    pub fn output_closed(&self) -> bool {
        process_output_closed(&self.state)
    }

    #[napi(catch_unwind)]
    pub fn wait(&self) -> AsyncTask<WaitProcessTask> {
        AsyncTask::new(WaitProcessTask {
            state: self.state.clone(),
        })
    }

    #[napi(catch_unwind)]
    pub fn set_timeout(&self, milliseconds: u32) {
        process_set_timeout(&self.state, milliseconds);
    }

    #[napi(catch_unwind)]
    pub fn clear_timeout(&self) {
        process_clear_timeout(&self.state);
    }

    #[napi(catch_unwind)]
    pub fn timed_out(&self) -> bool {
        process_timed_out(&self.state)
    }

    #[napi(catch_unwind)]
    pub fn terminate(&self) {
        process_signal(&self.state, false);
    }

    #[napi(catch_unwind)]
    pub fn kill(&self) {
        process_signal(&self.state, true);
    }
}

fn consume_csi(characters: &[char], mut cursor: usize) -> usize {
    while cursor < characters.len() {
        let character = characters[cursor];
        cursor += 1;
        if ('@'..='~').contains(&character) {
            break;
        }
    }
    cursor
}

fn consume_terminal_string(characters: &[char], mut cursor: usize, bell_terminated: bool) -> usize {
    while cursor < characters.len() {
        if bell_terminated && characters[cursor] == '\u{0007}' {
            return cursor + 1;
        }
        if characters[cursor] == '\u{009c}' {
            return cursor + 1;
        }
        if characters[cursor] == '\u{001b}' && characters.get(cursor + 1) == Some(&'\\') {
            return cursor + 2;
        }
        cursor += 1;
    }
    cursor
}

fn consume_escape(characters: &[char], mut cursor: usize) -> usize {
    let Some(introducer) = characters.get(cursor).copied() else {
        return cursor;
    };
    cursor += 1;
    match introducer {
        '[' => consume_csi(characters, cursor),
        ']' => consume_terminal_string(characters, cursor, true),
        'P' | 'X' | '^' | '_' => consume_terminal_string(characters, cursor, false),
        '\u{0020}'..='\u{002f}' => {
            while characters
                .get(cursor)
                .is_some_and(|character| ('\u{0020}'..='\u{002f}').contains(character))
            {
                cursor += 1;
            }
            if characters
                .get(cursor)
                .is_some_and(|character| ('\u{0030}'..='\u{007e}').contains(character))
            {
                cursor += 1;
            }
            cursor
        }
        _ => cursor,
    }
}

fn strip_terminal_controls(text: &str) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < characters.len() {
        match characters[cursor] {
            '\u{001b}' => cursor = consume_escape(&characters, cursor + 1),
            '\u{009b}' => cursor = consume_csi(&characters, cursor + 1),
            '\u{009d}' => cursor = consume_terminal_string(&characters, cursor + 1, true),
            '\u{0090}' | '\u{0098}' | '\u{009e}' | '\u{009f}' => {
                cursor = consume_terminal_string(&characters, cursor + 1, false);
            }
            '\u{0080}'..='\u{009f}' => cursor += 1,
            character => {
                output.push(character);
                cursor += 1;
            }
        }
    }
    output
}

#[napi(js_name = "nativeNormalizeProcessOutput", catch_unwind)]
pub fn native_normalize_process_output(output: Utf16String) -> Utf16String {
    let source = String::from_utf16_lossy(&output).replace("\r\n", "\n");
    let stripped = strip_terminal_controls(&source);
    stripped
        .split('\n')
        .map(|line| {
            let line = line.rsplit_once('\r').map_or(line, |(_, tail)| tail);
            let mut normalized = Vec::new();
            for character in line.chars() {
                if character == '\u{0008}' {
                    normalized.pop();
                    continue;
                }
                if (character < ' ' && character != '\t') || character == '\u{007f}' {
                    continue;
                }
                normalized.push(character);
            }
            normalized.into_iter().collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .into()
}

impl Drop for NativeProcess {
    fn drop(&mut self) {
        let mut output = lock(&self.state.output);
        output.closed = true;
        self.state.output_changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::native_normalize_process_output;

    #[test]
    fn normalizes_terminal_output() {
        let output = native_normalize_process_output(
            "before\rreplace\n\u{001b}[31mred\u{001b}[0m\nab\u{0008}c"
                .to_owned()
                .into(),
        );
        assert_eq!(String::from_utf16_lossy(&output), "replace\nred\nac");
    }

    #[test]
    fn strips_extended_terminal_control_families() {
        let output = native_normalize_process_output(
            "a\u{009b}31mb\u{001b}Psecret\u{001b}\\c\u{001b}(0d\u{009d}title\u{009c}e"
                .to_owned()
                .into(),
        );
        assert_eq!(String::from_utf16_lossy(&output), "abcde");
    }
}
