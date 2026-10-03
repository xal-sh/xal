use super::*;

pub(super) fn file_uri(path: &Path) -> std::io::Result<String> {
    reqwest13::Url::from_file_path(path)
        .map(String::from)
        .map_err(|()| failed(format!("Cannot create file URI for {}", path.display())))
}

pub(super) fn uri_path(uri: &str) -> Option<PathBuf> {
    reqwest13::Url::parse(uri).ok()?.to_file_path().ok()
}

fn read_frame(reader: &mut BufReader<impl Read>) -> Result<Option<Value>, String> {
    let mut content_length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let count = reader
            .by_ref()
            .take(
                u64::try_from(MAX_HEADER_BYTES - header_bytes + 1).expect("header length fits u64"),
            )
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return if header_bytes == 0 {
                Ok(None)
            } else {
                Err("Truncated LSP message header".into())
            };
        }
        header_bytes += count;
        if header_bytes > MAX_HEADER_BYTES {
            return Err("LSP message header exceeds 8192 bytes".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.trim_end().split_once(':') else {
            return Err("Malformed LSP message header".into());
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err("LSP message must contain one positive Content-Length header".into());
            }
            let parsed = value.trim().parse::<usize>().map_err(|_| {
                "LSP message must contain one positive Content-Length header".to_owned()
            })?;
            if parsed == 0 || parsed > MAX_CONTENT_BYTES {
                return Err(format!(
                    "LSP message Content-Length exceeds {MAX_CONTENT_BYTES} bytes"
                ));
            }
            content_length = Some(parsed);
        }
    }
    let length = content_length
        .ok_or_else(|| "LSP message must contain one positive Content-Length header".to_owned())?;
    let mut content = vec![0; length];
    reader
        .read_exact(&mut content)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&content)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(super) fn read_messages(
    stream: impl Read,
    sender: mpsc::SyncSender<Result<Value, String>>,
    stop: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(stream);
    loop {
        let mut message = match read_frame(&mut reader) {
            Ok(Some(value)) => Ok(value),
            Ok(None) => return,
            Err(error) => Err(error),
        };
        let failed = message.is_err();
        loop {
            if stop.load(Ordering::Acquire) {
                return;
            }
            match sender.try_send(message) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(value)) => {
                    message = value;
                    thread::sleep(Duration::from_millis(10));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => return,
            }
        }
        if failed {
            return;
        }
    }
}

pub(super) fn read_stderr(
    mut stream: impl Read,
    bytes: Arc<Mutex<Vec<u8>>>,
) -> std::io::Result<()> {
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let mut captured = lock(&bytes);
        captured.extend_from_slice(&buffer[..count]);
        if captured.len() > STDERR_LIMIT {
            let remove = captured.len() - STDERR_LIMIT;
            captured.drain(..remove);
        }
    }
}

type Outgoing = (Vec<u8>, mpsc::SyncSender<std::io::Result<()>>);

pub(super) struct Writer {
    sender: Option<mpsc::SyncSender<Outgoing>>,
    worker: Option<thread::JoinHandle<()>>,
    #[cfg(unix)]
    stop: Arc<AtomicBool>,
}

impl Writer {
    pub(super) fn new(stdin: ChildStdin) -> Self {
        #[cfg(unix)]
        let stop = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        let stdin = crate::process::Pipe::new(stdin, stop.clone());
        let mut stdin = stdin;
        let (sender, receiver) = mpsc::sync_channel::<Outgoing>(1);
        let worker = thread::spawn(move || {
            while let Ok((content, reply)) = receiver.recv() {
                let result = stdin
                    .write_all(format!("Content-Length: {}\r\n\r\n", content.len()).as_bytes())
                    .and_then(|()| stdin.write_all(&content))
                    .and_then(|()| stdin.flush());
                let failed = result.is_err();
                if reply.send(result).is_err() || failed {
                    return;
                }
            }
        });
        Self {
            sender: Some(sender),
            worker: Some(worker),
            #[cfg(unix)]
            stop,
        }
    }

    pub(super) fn send(
        &self,
        value: &Value,
        timeout: Duration,
        cancel: &dyn Fn() -> bool,
    ) -> std::io::Result<()> {
        cancelled(cancel)?;
        let content = serde_json::to_vec(value).map_err(|error| failed(error.to_string()))?;
        if content.len() > MAX_CONTENT_BYTES {
            return Err(invalid(format!(
                "LSP message exceeds {MAX_CONTENT_BYTES} bytes"
            )));
        }
        let (sender, reply) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or_else(|| failed("LSP writer is closed"))?
            .try_send((content, sender))
            .map_err(|error| failed(format!("LSP writer unavailable: {error}")))?;
        let deadline = Instant::now() + timeout;
        loop {
            cancelled(cancel)?;
            if Instant::now() >= deadline {
                return Err(Error::new(
                    ErrorKind::TimedOut,
                    "LSP server stdin timed out",
                ));
            }
            match reply.recv_timeout(Duration::from_millis(10)) {
                Ok(result) => {
                    return result
                        .map_err(|error| failed(format!("LSP server stdin failed: {error}")));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failed("LSP writer ended unexpectedly"));
                }
            }
        }
    }

    pub(super) fn close(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        self.stop.store(true, Ordering::Release);
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| failed("LSP writer panicked"))?;
        }
        Ok(())
    }
}

pub(super) fn json_id(value: &Value) -> Option<Value> {
    match value {
        Value::String(_) | Value::Number(_) => Some(value.clone()),
        _ => None,
    }
}

#[cfg(unix)]
pub(super) fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    crate::process::signal_group(child.id(), libc::SIGKILL, || child.try_wait().map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_bounds_and_truncation_are_enforced() {
        for input in [
            b"Content-Length: 16777217\r\n\r\n".to_vec(),
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            b"Content-Length: 2\r\n".to_vec(),
            vec![b'x'; MAX_HEADER_BYTES + 1],
        ] {
            assert!(read_frame(&mut BufReader::new(input.as_slice())).is_err());
        }
        assert_eq!(
            read_frame(&mut BufReader::new(
                b"Content-Length: 2\r\n\r\n{}".as_slice()
            ))
            .unwrap(),
            Some(json!({}))
        );
    }
}
