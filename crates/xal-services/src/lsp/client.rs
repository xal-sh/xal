use super::*;

struct OpenDocument {
    version: i64,
    language_id: String,
    text: String,
    opened: bool,
}

#[derive(Default)]
struct TextDocumentSync {
    open_close: bool,
    change: i64,
    save: bool,
    include_text: bool,
}

pub(super) struct RpcClient {
    pub(super) id: String,
    pub(super) root: PathBuf,
    timeout: Duration,
    child: Child,
    #[cfg(windows)]
    tree: crate::process::ProcessTree,
    writer: Writer,
    stopped: bool,
    stop_readers: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
    stderr_reader: Option<thread::JoinHandle<std::io::Result<()>>>,
    incoming: mpsc::Receiver<Result<Value, String>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    next_id: i64,
    pub(super) capabilities: Value,
    settings: Option<Value>,
    sync: TextDocumentSync,
    documents: HashMap<PathBuf, OpenDocument>,
    pub(super) diagnostics: HashMap<PathBuf, (Option<i64>, Vec<Value>)>,
    pub(super) pull_diagnostics: HashMap<PathBuf, (String, Vec<Value>)>,
}

fn configuration_value(settings: Option<&Value>, section: Option<&str>) -> Value {
    let Some(section) = section.filter(|section| !section.is_empty()) else {
        return settings.cloned().unwrap_or(Value::Null);
    };
    let mut current = settings;
    for key in section.split('.') {
        let Some(next) = current
            .and_then(Value::as_object)
            .and_then(|value| value.get(key))
        else {
            return Value::Null;
        };
        current = Some(next);
    }
    current.cloned().unwrap_or(Value::Null)
}

impl RpcClient {
    pub(super) fn start(
        config: &ServerConfig,
        root: &Path,
        command: &Path,
        app_name: &str,
        app_version: &str,
        cancelled_flag: &dyn Fn() -> bool,
    ) -> std::io::Result<Self> {
        cancelled(cancelled_flag)?;
        let mut process = Command::new(command);
        process
            .args(&config.args)
            .current_dir(root)
            .env_clear()
            .envs(environment(config))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        #[cfg(windows)]
        let (mut child, tree) = crate::process::ProcessTree::spawn(&mut process)?;
        #[cfg(not(windows))]
        let mut child = process.spawn().map_err(|error| {
            failed(format!(
                "Failed to initialize LSP server {}: {error}",
                config.id
            ))
        })?;
        let stdin = child.stdin.take().expect("piped LSP stdin");
        let stdout = child.stdout.take().expect("piped LSP stdout");
        let stderr = child.stderr.take().expect("piped LSP stderr");
        let (sender, incoming) = mpsc::sync_channel(8);
        let stop_readers = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        let stdout = crate::process::Pipe::new(stdout, stop_readers.clone());
        #[cfg(unix)]
        let stderr = crate::process::Pipe::new(stderr, stop_readers.clone());
        let reader_stop = stop_readers.clone();
        let reader = thread::spawn(move || read_messages(stdout, sender, reader_stop));
        let stderr_bytes = Arc::new(Mutex::new(Vec::new()));
        let thread_bytes = stderr_bytes.clone();
        let stderr_reader = thread::spawn(move || read_stderr(stderr, thread_bytes));
        let mut client = Self {
            id: config.id.clone(),
            root: root.to_path_buf(),
            timeout: Duration::from_millis(config.timeout_ms),
            child,
            #[cfg(windows)]
            tree,
            writer: Writer::new(stdin),
            stopped: false,
            stop_readers,
            reader: Some(reader),
            stderr_reader: Some(stderr_reader),
            incoming,
            stderr: stderr_bytes,
            next_id: 1,
            capabilities: json!({}),
            settings: config.settings.clone().map(Value::Object),
            sync: TextDocumentSync::default(),
            documents: HashMap::new(),
            diagnostics: HashMap::new(),
            pull_diagnostics: HashMap::new(),
        };
        if let Err(error) = client.initialize(config, root, app_name, app_version, cancelled_flag) {
            let cleanup = client.stop(false);
            let stderr = client.stderr();
            let reason = if stderr.is_empty() {
                error.to_string()
            } else {
                format!("{error} · {stderr}")
            };
            return Err(match cleanup {
                Ok(()) => Error::new(error.kind(), reason),
                Err(cleanup) => failed(format!("{reason}; cleanup failed: {cleanup}")),
            });
        }
        Ok(client)
    }

    fn initialize(
        &mut self,
        config: &ServerConfig,
        root: &Path,
        app_name: &str,
        app_version: &str,
        cancelled_flag: &dyn Fn() -> bool,
    ) -> std::io::Result<()> {
        let root_uri = file_uri(root)?;
        let root_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace");
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": app_name, "version": app_version },
            "rootUri": root_uri,
            "workspaceFolders": [{ "name": root_name, "uri": root_uri }],
            "capabilities": {
                "general": { "positionEncodings": ["utf-16"] },
                "window": { "workDoneProgress": true },
                "workspace": {
                    "applyEdit": false,
                    "configuration": true,
                    "workspaceFolders": true,
                    "symbol": { "dynamicRegistration": false }
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "didSave": true
                    },
                    "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "dynamicRegistration": false, "linkSupport": true },
                    "references": { "dynamicRegistration": false },
                    "documentSymbol": { "dynamicRegistration": false, "hierarchicalDocumentSymbolSupport": true },
                    "implementation": { "dynamicRegistration": false, "linkSupport": true },
                    "diagnostic": { "dynamicRegistration": false, "relatedDocumentSupport": false },
                    "publishDiagnostics": { "relatedInformation": true, "versionSupport": true },
                    "callHierarchy": { "dynamicRegistration": false }
                }
            }
        });
        if let Some(options) = &config.initialization_options {
            params
                .as_object_mut()
                .expect("initialize parameters are an object")
                .insert(
                    "initializationOptions".to_owned(),
                    Value::Object(options.clone()),
                );
        }
        let result = self.request("initialize", params, cancelled_flag)?;
        let capabilities = result
            .as_object()
            .and_then(|result| result.get("capabilities"))
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| {
                failed(format!(
                    "LSP server {} returned invalid initialize capabilities",
                    self.id
                ))
            })?;
        if let Some(encoding) = capabilities.get("positionEncoding")
            && encoding != "utf-16"
        {
            return Err(failed(format!(
                "LSP server {} selected unsupported position encoding {}",
                self.id, encoding
            )));
        }
        self.capabilities = Value::Object(capabilities);
        self.sync = text_document_sync(&self.capabilities);
        self.notify("initialized", json!({}), cancelled_flag)?;
        if let Some(settings) = &self.settings {
            self.notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": settings }),
                cancelled_flag,
            )?;
        }
        Ok(())
    }

    pub(super) fn stderr(&self) -> String {
        let text = String::from_utf8_lossy(&lock(&self.stderr))
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.chars().count() <= STDERR_DISPLAY_LIMIT {
            return text;
        }
        let suffix = text
            .chars()
            .rev()
            .take(STDERR_DISPLAY_LIMIT - 1)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        format!("…{suffix}")
    }

    fn notify(
        &self,
        method: &str,
        params: Value,
        cancel: &dyn Fn() -> bool,
    ) -> std::io::Result<()> {
        self.writer.send(
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
            self.timeout,
            cancel,
        )
    }

    fn respond(&self, id: Value, result: Value, cancel: &dyn Fn() -> bool) -> std::io::Result<()> {
        self.writer.send(
            &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            self.timeout,
            cancel,
        )
    }

    fn handle_message(
        &mut self,
        value: Value,
        wanted: i64,
        cancel: &dyn Fn() -> bool,
    ) -> std::io::Result<Option<Value>> {
        let object = value
            .as_object()
            .ok_or_else(|| failed("Invalid LSP JSON-RPC message"))?;
        if object.get("jsonrpc") != Some(&Value::String("2.0".to_owned())) {
            return Err(failed("Invalid LSP JSON-RPC message"));
        }
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            if let Some(id) = object.get("id").and_then(json_id) {
                let result = match method {
                    "workspace/configuration" => params
                        .get("items")
                        .and_then(Value::as_array)
                        .map(|items| {
                            Value::Array(
                                items
                                    .iter()
                                    .map(|item| {
                                        configuration_value(
                                            self.settings.as_ref(),
                                            item.get("section").and_then(Value::as_str),
                                        )
                                    })
                                    .collect(),
                            )
                        })
                        .unwrap_or_else(|| Value::Array(Vec::new())),
                    "workspace/workspaceFolders" => Value::Array(vec![json!({
                        "name": self.root.file_name().and_then(|name| name.to_str()).unwrap_or("workspace"),
                        "uri": file_uri(&self.root)?
                    })]),
                    "window/workDoneProgress/create" | "client/registerCapability" => Value::Null,
                    _ => {
                        self.writer.send(
                            &json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32601, "message": "Method not found" }
                            }),
                            self.timeout,
                            cancel,
                        )?;
                        return Ok(None);
                    }
                };
                self.respond(id, result, cancel)?;
                return Ok(None);
            }
            if method == "textDocument/publishDiagnostics" {
                self.store_diagnostics(&params)?;
            }
            return Ok(None);
        }
        let Some(id) = object.get("id").and_then(Value::as_i64) else {
            return Err(failed("Invalid LSP response ID"));
        };
        if id != wanted {
            return Ok(None);
        }
        match (object.get("result"), object.get("error")) {
            (Some(result), None) => Ok(Some(result.clone())),
            (None, Some(error)) => {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown LSP error");
                Err(failed(format!("LSP request failed ({code}): {message}")))
            }
            _ => Err(failed(
                "LSP response must contain exactly one of result or error",
            )),
        }
    }

    pub(super) fn request(
        &mut self,
        method: &str,
        params: Value,
        cancelled_flag: &dyn Fn() -> bool,
    ) -> std::io::Result<Value> {
        cancelled(cancelled_flag)?;
        let id = self.next_id;
        self.next_id += 1;
        self.writer.send(
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            self.timeout,
            cancelled_flag,
        )?;
        let deadline = Instant::now() + self.timeout;
        loop {
            if cancelled_flag() || Instant::now() >= deadline {
                let kind = if cancelled_flag() {
                    ErrorKind::Interrupted
                } else {
                    ErrorKind::TimedOut
                };
                let reason = if kind == ErrorKind::Interrupted {
                    "LSP request was cancelled".into()
                } else {
                    format!(
                        "LSP request {method} timed out after {}ms",
                        self.timeout.as_millis()
                    )
                };
                let notification = self.writer.send(
                    &json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}),
                    Duration::from_millis(100),
                    &|| false,
                );
                return Err(Error::new(
                    kind,
                    match notification {
                        Ok(()) => reason,
                        Err(error) => {
                            format!("{reason}; cancellation notification failed: {error}")
                        }
                    },
                ));
            }
            match self.incoming.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(value)) => {
                    if let Some(result) = self.handle_message(value, id, cancelled_flag)? {
                        return Ok(result);
                    }
                }
                Ok(Err(error)) => {
                    return Err(failed(format!("LSP server stdout failed: {error}")));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let error = format!("LSP server {} stdout ended unexpectedly", self.id);
                    return Err(failed(error));
                }
            }
        }
    }

    pub(super) fn drain_until(
        &mut self,
        deadline: Instant,
        cancelled_flag: &dyn Fn() -> bool,
        diagnostic_path: Option<(&Path, i64)>,
    ) -> std::io::Result<bool> {
        loop {
            cancelled(cancelled_flag)?;
            if let Some((path, version)) = diagnostic_path
                && self
                    .diagnostics
                    .get(path)
                    .is_some_and(|(published, _)| published.is_none_or(|value| value == version))
            {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            match self.incoming.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(value)) => {
                    self.handle_message(value, -1, cancelled_flag)?;
                }
                Ok(Err(error)) => return Err(failed(format!("LSP server stdout failed: {error}"))),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failed(format!(
                        "LSP server {} stdout ended unexpectedly",
                        self.id
                    )));
                }
            }
        }
    }

    fn store_diagnostics(&mut self, params: &Value) -> std::io::Result<()> {
        let uri = params.get("uri").and_then(Value::as_str).ok_or_else(|| {
            failed(format!(
                "LSP server {} published malformed diagnostics",
                self.id
            ))
        })?;
        let path = uri_path(uri).ok_or_else(|| {
            failed(format!(
                "LSP server {} published diagnostics for an invalid file URI",
                self.id
            ))
        })?;
        let items = params
            .get("diagnostics")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                failed(format!(
                    "LSP server {} published malformed diagnostics",
                    self.id
                ))
            })?;
        let version = params.get("version").and_then(Value::as_i64);
        self.diagnostics.insert(path, (version, items));
        Ok(())
    }

    pub(super) fn sync_document(
        &mut self,
        path: &Path,
        language_id: &str,
        cancelled_flag: &dyn Fn() -> bool,
    ) -> std::io::Result<(String, i64, bool)> {
        cancelled(cancelled_flag)?;
        let text = read_document(path, cancelled_flag).map_err(|error| {
            Error::new(
                error.kind(),
                format!("Cannot synchronize {}: {error}", path.display()),
            )
        })?;
        if text.contains('\0') {
            return Err(failed(format!(
                "Cannot synchronize binary file: {}",
                path.display()
            )));
        }
        let uri = file_uri(path)?;
        if let Some(previous) = self.documents.get(path)
            && previous.text == text
            && previous.language_id == language_id
        {
            return Ok((uri, previous.version, false));
        }
        let previous = self.documents.remove(path);
        let version = previous.as_ref().map_or(0, |document| document.version + 1);
        let opened = self.sync.open_close;
        self.diagnostics.remove(path);
        self.pull_diagnostics.remove(path);
        if previous
            .as_ref()
            .is_some_and(|document| document.language_id != language_id && document.opened)
        {
            self.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri } }),
                cancelled_flag,
            )?;
        }
        let previous_same_language = previous
            .as_ref()
            .filter(|document| document.language_id == language_id);
        if let Some(previous) = previous_same_language {
            if opened && self.sync.change == 0 {
                self.notify(
                    "textDocument/didClose",
                    json!({ "textDocument": { "uri": uri } }),
                    cancelled_flag,
                )?;
                self.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": version, "text": text } }),
                    cancelled_flag,
                )?;
            } else if self.sync.change != 0 {
                let changes = if self.sync.change == 2 {
                    json!([{ "range": { "start": { "line": 0, "character": 0 }, "end": end_position(&previous.text) }, "text": text }])
                } else {
                    json!([{ "text": text }])
                };
                self.notify(
                    "textDocument/didChange",
                    json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": changes }),
                    cancelled_flag,
                )?;
            }
        } else if opened {
            self.notify(
                "textDocument/didOpen",
                json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": version, "text": text } }),
                    cancelled_flag,
            )?;
        }
        if self.sync.save {
            let params = if self.sync.include_text {
                json!({ "textDocument": { "uri": uri }, "text": text })
            } else {
                json!({ "textDocument": { "uri": uri } })
            };
            self.notify("textDocument/didSave", params, cancelled_flag)?;
        }
        self.documents.insert(
            path.to_path_buf(),
            OpenDocument {
                version,
                language_id: language_id.to_owned(),
                text,
                opened,
            },
        );
        Ok((uri, version, true))
    }

    pub(super) fn stop(&mut self, graceful: bool) -> std::io::Result<()> {
        if self.stopped {
            return Ok(());
        }
        let mut failures = Vec::new();
        self.timeout = self.timeout.min(Duration::from_millis(500));
        let deadline = Instant::now() + self.timeout;
        let expired = || Instant::now() >= deadline;
        match self.child.try_wait() {
            Ok(None) if graceful => {
                for path in self
                    .documents
                    .iter()
                    .filter(|(_, document)| document.opened)
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>()
                {
                    match file_uri(path).and_then(|uri| {
                        self.notify(
                            "textDocument/didClose",
                            json!({"textDocument":{"uri":uri}}),
                            &expired,
                        )
                    }) {
                        Ok(()) => {}
                        Err(error) => {
                            failures.push(error.to_string());
                            break;
                        }
                    }
                }
                if let Err(error) = self.request("shutdown", Value::Null, &expired) {
                    failures.push(format!("LSP shutdown failed: {error}"));
                }
                if let Err(error) = self.notify("exit", Value::Null, &expired) {
                    failures.push(format!("LSP exit notification failed: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => failures.push(error.to_string()),
        }
        self.stop_readers.store(true, Ordering::Release);
        #[cfg(windows)]
        let termination = self.tree.terminate();
        #[cfg(not(windows))]
        let termination = terminate_process_tree(&mut self.child);
        if let Err(error) = termination {
            failures.push(error.to_string());
        }
        if let Err(error) = self.child.wait() {
            failures.push(error.to_string());
        }
        if let Err(error) = self.writer.close() {
            failures.push(error.to_string());
        }
        if let Some(reader) = self.reader.take()
            && reader.join().is_err()
        {
            failures.push("LSP reader panicked".into());
        }
        if let Some(reader) = self.stderr_reader.take() {
            match reader.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(error.to_string()),
                Err(_) => failures.push("LSP stderr reader panicked".into()),
            }
        }
        self.stopped = true;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failed(failures.join("; ")))
        }
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        if self.stop(false).is_err() {
            eprintln!("LSP process cleanup failed");
        }
    }
}

fn read_document(path: &Path, cancel: &dyn Fn() -> bool) -> std::io::Result<String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("LSP synchronization requires a regular file"));
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        cancelled(cancel)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_CONTENT_BYTES {
            return Err(invalid("LSP document exceeds 16 MiB"));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    String::from_utf8(bytes).map_err(|error| failed(error.to_string()))
}

fn text_document_sync(capabilities: &Value) -> TextDocumentSync {
    let Some(value) = capabilities.get("textDocumentSync") else {
        return TextDocumentSync::default();
    };
    if let Some(change) = value.as_i64() {
        return TextDocumentSync {
            open_close: change != 0,
            change,
            save: false,
            include_text: false,
        };
    }
    let Some(value) = value.as_object() else {
        return TextDocumentSync::default();
    };
    let save = value.get("save");
    TextDocumentSync {
        open_close: value.get("openClose").and_then(Value::as_bool) == Some(true),
        change: value.get("change").and_then(Value::as_i64).unwrap_or(0),
        save: save.and_then(Value::as_bool) == Some(true) || save.is_some_and(Value::is_object),
        include_text: save
            .and_then(Value::as_object)
            .and_then(|save| save.get("includeText"))
            .and_then(Value::as_bool)
            == Some(true),
    }
}

fn end_position(text: &str) -> Value {
    let mut line = 0;
    let mut character = 0;
    let mut characters = text.chars().peekable();
    while let Some(current) = characters.next() {
        if current == '\r' {
            if characters.peek() == Some(&'\n') {
                characters.next();
            }
            line += 1;
            character = 0;
        } else if current == '\n' {
            line += 1;
            character = 0;
        } else {
            character += current.len_utf16();
        }
    }
    json!({ "line": line, "character": character })
}

#[cfg(test)]
mod tests {
    use super::end_position;
    use serde_json::json;

    #[test]
    fn computes_end_positions_for_crlf_documents() {
        assert_eq!(
            end_position("one\r\ntwo😀"),
            json!({ "line": 1, "character": 5 })
        );
        assert_eq!(
            end_position("one\r\n"),
            json!({ "line": 1, "character": 0 })
        );
    }
}
