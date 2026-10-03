use super::*;

pub(super) struct OutputQueue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    pub(super) closed: bool,
}

pub(crate) struct ProcessState {
    child: Mutex<Option<Child>>,
    #[cfg(unix)]
    pub(super) stdin: Mutex<Option<Pipe<ChildStdin>>>,
    #[cfg(not(unix))]
    pub(super) stdin: Mutex<Option<ChildStdin>>,
    #[cfg(unix)]
    stop_pipes: Arc<AtomicBool>,
    pub(super) output: Mutex<OutputQueue>,
    pub(super) output_changed: Condvar,
    readers: AtomicUsize,
    reader_error: Mutex<Option<String>>,
    termination: Mutex<Option<ProcessTermination>>,
    terminated: Condvar,
    deadline: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    tree: super::windows::Tree,
}

pub(super) fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn push_output(state: &ProcessState, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let mut output = lock(&state.output);
    if output.bytes.saturating_add(bytes.len()) > OUTPUT_CAPACITY {
        output.closed = true;
        drop(output);
        *lock(&state.reader_error) =
            Some("process output exceeded 64 MiB without being drained".into());
        signal_process_tree(state, true);
        return;
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
    let _output = lock(&state.output);
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
            Some(exit_code) => ProcessTermination {
                status: "exited".to_owned(),
                exit_code: Some(exit_code),
                signal: None,
            },
            None => ProcessTermination {
                status: "signaled".to_owned(),
                exit_code: None,
                signal: signal_name(&status),
            },
        },
        Err(error) => ProcessTermination {
            status: "launchFailed".to_owned(),
            exit_code: None,
            signal: Some(error.to_string()),
        },
    };
    signal_process_tree(&state, true);
    #[cfg(unix)]
    state
        .stop_pipes
        .store(true, std::sync::atomic::Ordering::Release);
    *lock(&state.stdin) = None;
    *lock(&state.termination) = Some(termination);
    state.terminated.notify_all();
}

pub(super) fn signal_process_tree(state: &ProcessState, force: bool) {
    #[cfg(unix)]
    let result = super::signal_group(
        state.pid,
        if force { libc::SIGKILL } else { libc::SIGTERM },
        || match lock(&state.child).as_mut() {
            Some(child) => child.try_wait().map(|_| ()),
            None => Ok(()),
        },
    );
    #[cfg(windows)]
    let result = {
        let _ = force;
        state.tree.terminate()
    };
    if let Err(error) = result {
        *lock(&state.reader_error) = Some(format!("could not terminate process tree: {error}"));
        if let Some(child) = lock(&state.child).as_mut()
            && let Err(cleanup) = child.kill()
        {
            *lock(&state.reader_error) = Some(format!(
                "could not terminate process tree: {error}; child cleanup failed: {cleanup}"
            ));
        }
    }
}

pub(crate) fn spawn_process(request: ProcessRequest) -> std::io::Result<Arc<ProcessState>> {
    let executable = request
        .launch
        .first()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                std::io::ErrorKind::InvalidInput,
                "process launch is required".to_owned(),
            )
        })?;
    if request.cwd.is_empty() {
        return Err(Error::new(
            std::io::ErrorKind::InvalidInput,
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
    #[cfg(windows)]
    let (mut child, tree) = super::windows::Tree::spawn(&mut command)?;
    #[cfg(unix)]
    let mut child = command
        .spawn()
        .map_err(|error| Error::other(format!("failed to launch: {error}")))?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::other("native process stdout was unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::other("native process stderr was unavailable".to_owned()))?;
    #[cfg(unix)]
    let stop_pipes = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    let stdin = stdin.map(|stdin| Pipe::new(stdin, stop_pipes.clone()));
    #[cfg(unix)]
    let stdout = Pipe::new(stdout, stop_pipes.clone());
    #[cfg(unix)]
    let stderr = Pipe::new(stderr, stop_pipes.clone());
    let state = Arc::new(ProcessState {
        #[cfg(unix)]
        pid: child.id(),
        #[cfg(windows)]
        tree,
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(stdin),
        #[cfg(unix)]
        stop_pipes,
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

pub(crate) fn process_termination(state: &ProcessState) -> Option<ProcessTermination> {
    lock(&state.termination).clone()
}

pub(crate) fn process_reader_error(state: &ProcessState) -> Option<String> {
    lock(&state.reader_error).clone()
}

pub(crate) fn process_write(state: &ProcessState, bytes: &[u8]) -> std::io::Result<()> {
    let mut stdin = lock(&state.stdin);
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| Error::other("native process stdin is closed".to_owned()))?;
    stdin
        .write_all(bytes)
        .map_err(|error| Error::other(error.to_string()))?;
    stdin
        .flush()
        .map_err(|error| Error::other(error.to_string()))
}

pub(super) fn process_set_timeout(state: &ProcessState, milliseconds: u32) {
    *lock(&state.deadline) = Some(Instant::now() + Duration::from_millis(u64::from(milliseconds)));
}

pub(super) fn process_clear_timeout(state: &ProcessState) {
    *lock(&state.deadline) = None;
}

pub(super) fn process_timed_out(state: &ProcessState) -> bool {
    state.timed_out.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn process_signal(state: &ProcessState, force: bool) {
    signal_process_tree(state, force);
}

pub(crate) fn process_interrupt(state: &ProcessState) -> bool {
    #[cfg(unix)]
    {
        i32::try_from(state.pid).is_ok_and(|pid| unsafe { libc::kill(-pid, libc::SIGINT) } == 0)
    }
    #[cfg(windows)]
    {
        signal_process_tree(state, false);
        true
    }
}

pub(crate) fn wait_process(state: &ProcessState) -> std::io::Result<ProcessTermination> {
    let mut termination = lock(&state.termination);
    while termination.is_none() {
        termination = state
            .terminated
            .wait(termination)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    let termination = termination
        .clone()
        .ok_or_else(|| Error::other("native process termination was unavailable".to_owned()))?;
    let mut output = lock(&state.output);
    while !process_output_closed(state) {
        output = state
            .output_changed
            .wait(output)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    drop(output);
    if let Some(error) = process_reader_error(state) {
        return Err(Error::other(format!(
            "could not read native process output: {error}"
        )));
    }
    Ok(termination)
}
