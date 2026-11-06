use super::*;

pub(super) struct OutputQueue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    pub(super) closed: bool,
    lossy: bool,
    dropped: u64,
}

struct OwnedProcess {
    child: Child,
    kill_deadline: Option<Instant>,
}

pub(crate) struct ProcessState {
    child: Mutex<Option<OwnedProcess>>,
    pub(super) stdin: Mutex<Option<ChildStdin>>,
    pub(super) output: Mutex<OutputQueue>,
    pub(super) output_changed: Condvar,
    readers: AtomicUsize,
    error: Mutex<Option<String>>,
    termination: Mutex<Option<NativeProcessTermination>>,
    terminated: Condvar,
    deadline: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    finalized: AtomicBool,
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
    let bytes = if bytes.len() > OUTPUT_CAPACITY {
        output.dropped = output
            .dropped
            .saturating_add((bytes.len() - OUTPUT_CAPACITY) as u64);
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
            output.dropped = output.dropped.saturating_add(dropped.len() as u64);
            continue;
        }
        let (next, timeout) = state
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

fn read_stream(state: Arc<ProcessState>, mut stream: impl Read) {
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => push_output(&state, buffer[..read].to_vec()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                record_error(
                    &state,
                    format!("could not read native process output: {error}"),
                );
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

fn expire_process(state: &ProcessState) {
    let mut deadline = lock(&state.deadline);
    if deadline.is_none_or(|deadline| Instant::now() < deadline) {
        return;
    }
    *deadline = None;
    drop(deadline);
    state
        .timed_out
        .store(true, std::sync::atomic::Ordering::Relaxed);
    signal_process_tree(state, true);
}

#[cfg(unix)]
fn observe_exit(child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
    use std::os::unix::process::ExitStatusExt;
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let info = unsafe { info.assume_init() };
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        let status = unsafe { info.si_status() };
        let raw = match info.si_code {
            libc::CLD_EXITED => status << 8,
            libc::CLD_KILLED => status,
            libc::CLD_DUMPED => status | 0x80,
            code => {
                return Err(std::io::Error::other(format!(
                    "unexpected child exit code: {code}"
                )));
            }
        };
        return Ok(Some(std::process::ExitStatus::from_raw(raw)));
    }
}

#[cfg(not(unix))]
fn observe_exit(child: &mut Child) -> std::io::Result<Option<std::process::ExitStatus>> {
    child.try_wait()
}

#[cfg(target_os = "macos")]
fn group_is_exited(pid: libc::pid_t) -> std::io::Result<bool> {
    let count = unsafe { libc::proc_listpgrppids(pid, std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut pids = vec![0; usize::try_from(count).map_err(std::io::Error::other)? + 1];
    let bytes =
        i32::try_from(std::mem::size_of_val(pids.as_slice())).map_err(std::io::Error::other)?;
    let found = unsafe { libc::proc_listpgrppids(pid, pids.as_mut_ptr().cast(), bytes) };
    if found <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let found = usize::try_from(found).map_err(std::io::Error::other)?;
    if found >= pids.len() {
        return Ok(false);
    }
    for member in &pids[..found] {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = i32::try_from(std::mem::size_of_val(&info)).map_err(std::io::Error::other)?;
        let read = unsafe {
            libc::proc_pidinfo(
                *member,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(error);
        }
        if read != size {
            return Err(std::io::Error::other(
                "incomplete process group member information",
            ));
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pgid == u32::try_from(pid).map_err(std::io::Error::other)?
            && info.pbi_status != libc::SZOMB
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn record_error(state: &ProcessState, message: String) {
    lock(&state.error).get_or_insert(message);
}

fn signal_owned(process: &mut OwnedProcess, force: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let pid = libc::pid_t::try_from(process.child.id()).map_err(std::io::Error::other)?;
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        if unsafe { libc::kill(-pid, signal) } != 0 {
            let error = std::io::Error::last_os_error();
            let absent = error.raw_os_error() == Some(libc::ESRCH);
            #[cfg(target_os = "macos")]
            let absent =
                absent || (error.raw_os_error() == Some(libc::EPERM) && group_is_exited(pid)?);
            if !absent {
                return Err(error);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &process.child.id().to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let status = command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            if !force {
                return Err(std::io::Error::other(format!("taskkill failed: {status}")));
            }
            process.child.kill()?;
        }
    }
    if force {
        process.kill_deadline = None;
    }
    Ok(())
}

fn escalate_process(state: &ProcessState) {
    let mut owned = lock(&state.child);
    let Some(process) = owned.as_mut() else {
        return;
    };
    if process
        .kill_deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
        && let Err(error) = signal_owned(process, true)
    {
        record_error(
            state,
            format!("could not kill native process group: {error}"),
        );
    }
}

fn watch_process(state: Arc<ProcessState>) {
    let status = loop {
        expire_process(&state);
        escalate_process(&state);
        let result = {
            let mut owned = lock(&state.child);
            let Some(process) = owned.as_mut() else {
                return;
            };
            let result = observe_exit(&mut process.child);
            if result.is_err() {
                *owned = None;
            }
            result
        };
        match result {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => break Err(error),
        }
    };
    let observed = status.is_ok();
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
        Err(error) => {
            record_error(
                &state,
                format!("could not observe native process exit: {error}"),
            );
            NativeProcessTermination {
                status: "launchFailed".to_owned(),
                exit_code: None,
                signal: Some(error.to_string()),
            }
        }
    };
    *lock(&state.stdin) = None;
    *lock(&state.termination) = Some(termination);
    if observed {
        while !process_output_closed(&state) {
            expire_process(&state);
            escalate_process(&state);
            thread::sleep(Duration::from_millis(10));
        }
        let mut owned = lock(&state.child);
        if let Some(process) = owned.as_mut() {
            if let Err(error) = signal_owned(process, true) {
                record_error(
                    &state,
                    format!("could not clean up native process group: {error}"),
                );
            }
            if let Err(error) = process.child.wait() {
                record_error(&state, format!("could not reap native process: {error}"));
            }
        }
        *owned = None;
    }
    let _termination = lock(&state.termination);
    state
        .finalized
        .store(true, std::sync::atomic::Ordering::Release);
    state.terminated.notify_all();
}

pub(super) fn signal_process_tree(state: &ProcessState, force: bool) {
    let mut owned = lock(&state.child);
    if let Some(process) = owned.as_mut()
        && let Err(error) = signal_owned(process, force)
    {
        record_error(
            state,
            format!("could not signal native process group: {error}"),
        );
    }
}

pub(crate) fn process_terminate_after(state: &ProcessState, grace: Duration) {
    let mut owned = lock(&state.child);
    let Some(process) = owned.as_mut() else {
        return;
    };
    process.kill_deadline = Some(Instant::now() + grace);
    if let Err(error) = signal_owned(process, false) {
        record_error(
            state,
            format!("could not terminate native process group: {error}"),
        );
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
        child: Mutex::new(Some(OwnedProcess {
            child,
            kill_deadline: None,
        })),
        stdin: Mutex::new(stdin),
        output: Mutex::new(OutputQueue {
            chunks: VecDeque::new(),
            bytes: 0,
            closed: false,
            lossy: false,
            dropped: 0,
        }),
        output_changed: Condvar::new(),
        readers: AtomicUsize::new(2),
        error: Mutex::new(None),
        termination: Mutex::new(None),
        terminated: Condvar::new(),
        deadline: Mutex::new(None),
        timed_out: AtomicBool::new(false),
        finalized: AtomicBool::new(false),
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
    output.lossy = false;
    state.output_changed.notify_all();
    bytes
}

pub(crate) fn process_dropped_bytes(state: &ProcessState) -> u64 {
    lock(&state.output).dropped
}

pub(crate) fn process_output_closed(state: &ProcessState) -> bool {
    state.readers.load(std::sync::atomic::Ordering::Acquire) == 0
}

pub(crate) fn process_termination(state: &ProcessState) -> Option<NativeProcessTermination> {
    lock(&state.termination).clone()
}

pub(crate) fn process_error(state: &ProcessState) -> Option<String> {
    lock(&state.error).clone()
}

pub(crate) fn process_finalized(state: &ProcessState) -> bool {
    state.finalized.load(std::sync::atomic::Ordering::Acquire)
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

pub(super) fn wait_process(state: &ProcessState) -> napi::Result<NativeProcessTermination> {
    let mut termination = lock(&state.termination);
    while !process_finalized(state) {
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
    if let Some(error) = process_error(state) {
        return Err(Error::new(Status::GenericFailure, error));
    }
    Ok(termination)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn wait_until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "process lifecycle did not settle"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn retains_exited_leader_until_descendant_cleanup_then_retires_identity() {
        for redirected in [false, true] {
            let redirect = if redirected {
                "exec >/dev/null 2>&1;"
            } else {
                ""
            };
            let process = NativeProcess::spawn(NativeProcessRequest {
                launch: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    format!(
                        "trap 'exit 0' TERM; /bin/sh -c 'trap \"\" TERM; printf \"%s ready\\n\" \"$$\"; {redirect} while :; do sleep 1; done' & while :; do sleep 1; done"
                    ),
                ],
                cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(),
                environment: vec![NativeEnvironmentVariable {
                    name: "PATH".into(),
                    value: "/usr/bin:/bin".into(),
                }],
                stdin: false,
            })
            .unwrap();
            let state = &process.state;
            let mut output = String::new();
            wait_until(|| {
                output.push_str(&String::from_utf8(process_drain(state)).unwrap());
                output.contains("ready\n")
            });
            let descendant = output.split_whitespace().next().unwrap().to_owned();
            process_terminate_after(state, Duration::from_secs(60));
            wait_until(|| process_termination(state).is_some());
            if !redirected {
                let mut owned = lock(&state.child);
                let child = owned
                    .as_mut()
                    .expect("leader must remain owned during grace");
                assert!(observe_exit(&mut child.child).unwrap().is_some());
                assert!(!process_finalized(state));
                child.kill_deadline = Some(Instant::now());
            }
            wait_until(|| process_finalized(state));
            assert_eq!(wait_process(state).unwrap().status, "exited");
            assert!(lock(&state.child).is_none());
            assert!(process_output_closed(state));
            wait_until(|| {
                let status = Command::new("/bin/ps")
                    .args(["-p", &descendant, "-o", "stat="])
                    .output()
                    .unwrap();
                !status.status.success()
                    || String::from_utf8(status.stdout)
                        .unwrap()
                        .trim_start()
                        .starts_with('Z')
            });
            thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| {
                        process_terminate_after(state, Duration::ZERO);
                        process_signal(state, true);
                    });
                }
            });
            assert!(lock(&state.child).is_none());
            assert!(process_error(state).is_none());
        }
    }
}
