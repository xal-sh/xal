use super::*;

pub(super) fn file_uri(path: &Path) -> napi::Result<String> {
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
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(None);
        }
        header_bytes += count;
        if header_bytes > MAX_HEADER_BYTES {
            return Err("LSP message header exceeds 8192 bytes".to_owned());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.trim_end().split_once(':') else {
            return Err("Malformed LSP message header".to_owned());
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(
                    "LSP message must contain one positive Content-Length header".to_owned(),
                );
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

pub(super) fn read_messages(stream: impl Read, sender: mpsc::Sender<Result<Value, String>>) {
    let mut reader = BufReader::new(stream);
    loop {
        match read_frame(&mut reader) {
            Ok(Some(value)) => {
                if sender.send(Ok(value)).is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        }
    }
}

pub(super) fn read_stderr(mut stream: impl Read, bytes: Arc<Mutex<Vec<u8>>>) {
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let mut captured = lock(&bytes);
        captured.extend_from_slice(&buffer[..count]);
        if captured.len() > STDERR_LIMIT {
            let remove = captured.len() - STDERR_LIMIT;
            captured.drain(..remove);
        }
    }
}

pub(super) fn write_message(stdin: &mut ChildStdin, value: &Value) -> napi::Result<()> {
    let content = serde_json::to_vec(value).map_err(|error| failed(error.to_string()))?;
    stdin
        .write_all(format!("Content-Length: {}\r\n\r\n", content.len()).as_bytes())
        .and_then(|()| stdin.write_all(&content))
        .and_then(|()| stdin.flush())
        .map_err(|error| failed(format!("LSP server stdin failed: {error}")))
}

pub(super) fn json_id(value: &Value) -> Option<Value> {
    match value {
        Value::String(_) | Value::Number(_) => Some(value.clone()),
        _ => None,
    }
}
pub(super) fn terminate_process_tree(child: &mut Child, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let _ = Command::new("kill")
            .args([signal, "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &child.id().to_string(), "/T"]);
        if force {
            command.arg("/F");
        }
        let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    if force {
        let _ = child.kill();
    }
}
