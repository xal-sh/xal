use super::*;

pub(super) struct ActiveRun {
    pub(super) state: Arc<RunState>,
    pub(super) needle: Vec<u8>,
    pub(super) holdback: usize,
    pub(super) pending: Vec<u8>,
}

pub(super) struct PersistentEntry {
    pub(super) process: Arc<ProcessState>,
    pub(super) workspace: String,
    pub(super) active: Mutex<Option<ActiveRun>>,
    pub(super) dead: AtomicBool,
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

fn expire_active(entry: &PersistentEntry) -> bool {
    lock(&entry.active)
        .as_ref()
        .is_some_and(|run| run.state.expire())
}

pub(super) fn dispatch_persistent(entry: Arc<PersistentEntry>) {
    loop {
        if expire_active(&entry) && !process_interrupt(&entry.process) {
            process_signal(&entry.process, true);
        }
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

pub(super) fn dispatch_isolated(process: Arc<ProcessState>, run: Arc<RunState>) {
    loop {
        if run.expire() {
            process_signal(&process, true);
        }
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

pub(super) fn marker() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = MARKER_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("__xal_{}_{stamp}_{sequence}__", std::process::id())
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
