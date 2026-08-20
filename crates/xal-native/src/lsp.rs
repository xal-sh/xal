#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::tool_contracts::cancellation_flag;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const STDERR_DISPLAY_LIMIT: usize = 500;
const MAX_ITEMS: usize = 250;

fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn cancelled(cancelled: &std::sync::atomic::AtomicBool) -> napi::Result<()> {
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(failed("LSP operation was cancelled"));
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum ServerDefinition {
    Enabled { server: Box<ServerConfig> },
    Disabled { id: String },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfig {
    id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    file_types: HashMap<String, String>,
    root_markers: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    initialization_options: Option<Map<String, Value>>,
    settings: Option<Map<String, Value>>,
    timeout_ms: u64,
    install: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Query {
    operation: String,
    file_path: String,
    line: Option<u32>,
    column: Option<u32>,
    query: Option<String>,
}

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

struct RpcClient {
    id: String,
    root: PathBuf,
    timeout: Duration,
    child: Child,
    stdin: ChildStdin,
    incoming: mpsc::Receiver<Result<Value, String>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    next_id: i64,
    capabilities: Value,
    settings: Option<Value>,
    sync: TextDocumentSync,
    documents: HashMap<PathBuf, OpenDocument>,
    diagnostics: HashMap<PathBuf, (Option<i64>, Vec<Value>)>,
    failed: Option<String>,
}

struct ManagerState {
    definitions: Vec<ServerDefinition>,
    clients: HashMap<String, Arc<Mutex<RpcClient>>>,
    failures: HashMap<String, (String, PathBuf, String)>,
    closing: bool,
    app_name: String,
    app_version: String,
}

#[napi]
pub struct NativeLspManager {
    state: Arc<Mutex<ManagerState>>,
}

fn client_key(server: &str, root: &Path) -> String {
    format!("{server}\0{}", root.display())
}

fn environment(config: &ServerConfig) -> HashMap<String, String> {
    let mut values = std::env::vars().collect::<HashMap<_, _>>();
    values.extend(config.env.clone());
    values
}

fn executable(config: &ServerConfig, cwd: &Path) -> Option<PathBuf> {
    let command = Path::new(&config.command);
    if command.is_absolute() {
        return command.is_file().then(|| command.to_path_buf());
    }
    let path = config
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())?;
    which::which_in(&config.command, Some(path), cwd).ok()
}

fn may_resolve_from_another_root(config: &ServerConfig) -> bool {
    if Path::new(&config.command).is_absolute() {
        return false;
    }
    config
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| !entry.is_absolute()))
}

fn unavailable_reason(config: &ServerConfig) -> String {
    let missing = if Path::new(&config.command).is_absolute() {
        format!("{} was not found or is not executable", config.command)
    } else {
        format!("{} was not found on PATH", config.command)
    };
    if let Some(install) = &config.install {
        return format!(
            "{missing}. Install it with {install} or override pluginConfig.lsp.servers.{}.command",
            config.id
        );
    }
    format!(
        "{missing}. Set pluginConfig.lsp.servers.{}.command to an executable name or absolute path",
        config.id
    )
}

fn server_root(path: &Path, cwd: &Path, markers: &[String]) -> napi::Result<PathBuf> {
    let mut directory = path
        .parent()
        .ok_or_else(|| failed(format!("Cannot determine parent of {}", path.display())))?
        .to_path_buf();
    loop {
        for marker in markers {
            match fs::symlink_metadata(directory.join(marker)) {
                Ok(_) => return Ok(directory),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(failed(format!(
                        "Cannot inspect language-server root marker {}: {error}",
                        directory.join(marker).display()
                    )));
                }
            }
        }
        let Some(parent) = directory.parent() else {
            break;
        };
        if parent == directory {
            break;
        }
        directory = parent.to_path_buf();
    }
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if path.starts_with(&cwd) {
        return Ok(cwd);
    }
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| failed(format!("Cannot determine parent of {}", path.display())))
}

fn file_uri(path: &Path) -> napi::Result<String> {
    reqwest13::Url::from_file_path(path)
        .map(String::from)
        .map_err(|()| failed(format!("Cannot create file URI for {}", path.display())))
}

fn uri_path(uri: &str) -> Option<PathBuf> {
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

fn read_messages(stream: impl Read, sender: mpsc::Sender<Result<Value, String>>) {
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

fn read_stderr(mut stream: impl Read, bytes: Arc<Mutex<Vec<u8>>>) {
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

fn write_message(stdin: &mut ChildStdin, value: &Value) -> napi::Result<()> {
    let content = serde_json::to_vec(value).map_err(|error| failed(error.to_string()))?;
    stdin
        .write_all(format!("Content-Length: {}\r\n\r\n", content.len()).as_bytes())
        .and_then(|()| stdin.write_all(&content))
        .and_then(|()| stdin.flush())
        .map_err(|error| failed(format!("LSP server stdin failed: {error}")))
}

fn json_id(value: &Value) -> Option<Value> {
    match value {
        Value::String(_) | Value::Number(_) => Some(value.clone()),
        _ => None,
    }
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
    fn start(
        config: &ServerConfig,
        root: &Path,
        command: &Path,
        app_name: &str,
        app_version: &str,
        cancelled_flag: &std::sync::atomic::AtomicBool,
    ) -> napi::Result<Self> {
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
        let mut child = process.spawn().map_err(|error| {
            failed(format!(
                "Failed to initialize LSP server {}: {error}",
                config.id
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| failed(format!("LSP server {} stdin was unavailable", config.id)))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failed(format!("LSP server {} stdout was unavailable", config.id)))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| failed(format!("LSP server {} stderr was unavailable", config.id)))?;
        let (sender, incoming) = mpsc::channel();
        thread::spawn(move || read_messages(stdout, sender));
        let stderr_bytes = Arc::new(Mutex::new(Vec::new()));
        let thread_bytes = stderr_bytes.clone();
        thread::spawn(move || read_stderr(stderr, thread_bytes));
        let mut client = Self {
            id: config.id.clone(),
            root: root.to_path_buf(),
            timeout: Duration::from_millis(config.timeout_ms),
            child,
            stdin,
            incoming,
            stderr: stderr_bytes,
            next_id: 1,
            capabilities: json!({}),
            settings: config.settings.clone().map(Value::Object),
            sync: TextDocumentSync::default(),
            documents: HashMap::new(),
            diagnostics: HashMap::new(),
            failed: None,
        };
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
        let result = client.request("initialize", params, cancelled_flag)?;
        let capabilities = result
            .as_object()
            .and_then(|result| result.get("capabilities"))
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| {
                failed(format!(
                    "LSP server {} returned invalid initialize capabilities",
                    config.id
                ))
            })?;
        if let Some(encoding) = capabilities.get("positionEncoding")
            && encoding != "utf-16"
        {
            return Err(failed(format!(
                "LSP server {} selected unsupported position encoding {}",
                config.id, encoding
            )));
        }
        client.capabilities = Value::Object(capabilities);
        client.sync = text_document_sync(&client.capabilities);
        client.notify("initialized", json!({}))?;
        if let Some(settings) = &client.settings {
            client.notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": settings }),
            )?;
        }
        Ok(client)
    }

    fn stderr(&self) -> String {
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

    fn notify(&mut self, method: &str, params: Value) -> napi::Result<()> {
        write_message(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
    }

    fn respond(&mut self, id: Value, result: Value) -> napi::Result<()> {
        write_message(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        )
    }

    fn handle_message(&mut self, value: Value, wanted: i64) -> napi::Result<Option<Value>> {
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
                        write_message(
                            &mut self.stdin,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32601, "message": "Method not found" }
                            }),
                        )?;
                        return Ok(None);
                    }
                };
                self.respond(id, result)?;
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

    fn request(
        &mut self,
        method: &str,
        params: Value,
        cancelled_flag: &std::sync::atomic::AtomicBool,
    ) -> napi::Result<Value> {
        cancelled(cancelled_flag)?;
        let id = self.next_id;
        self.next_id += 1;
        write_message(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )?;
        let deadline = Instant::now() + self.timeout;
        loop {
            if cancelled_flag.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = self.notify("$/cancelRequest", json!({ "id": id }));
                return Err(failed("LSP request was cancelled"));
            }
            if Instant::now() >= deadline {
                let _ = self.notify("$/cancelRequest", json!({ "id": id }));
                return Err(failed(format!(
                    "LSP request {method} timed out after {}ms",
                    self.timeout.as_millis()
                )));
            }
            match self.incoming.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(value)) => {
                    if let Some(result) = self.handle_message(value, id)? {
                        return Ok(result);
                    }
                }
                Ok(Err(error)) => {
                    self.failed = Some(error.clone());
                    return Err(failed(format!("LSP server stdout failed: {error}")));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let error = format!("LSP server {} stdout ended unexpectedly", self.id);
                    self.failed = Some(error.clone());
                    return Err(failed(error));
                }
            }
        }
    }

    fn drain_until(
        &mut self,
        deadline: Instant,
        cancelled_flag: &std::sync::atomic::AtomicBool,
        diagnostic_path: Option<(&Path, i64)>,
    ) -> napi::Result<bool> {
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
                    self.handle_message(value, -1)?;
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

    fn store_diagnostics(&mut self, params: &Value) -> napi::Result<()> {
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

    fn sync_document(
        &mut self,
        path: &Path,
        language_id: &str,
        cancelled_flag: &std::sync::atomic::AtomicBool,
    ) -> napi::Result<(String, i64, bool)> {
        cancelled(cancelled_flag)?;
        let text = fs::read_to_string(path)
            .map_err(|error| failed(format!("Cannot synchronize {}: {error}", path.display())))?;
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
        if previous
            .as_ref()
            .is_some_and(|document| document.language_id != language_id && document.opened)
        {
            self.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri } }),
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
                )?;
                self.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": version, "text": text } }),
                )?;
            } else if opened {
                let changes = if self.sync.change == 2 {
                    json!([{ "range": { "start": { "line": 0, "character": 0 }, "end": end_position(&previous.text) }, "text": text }])
                } else {
                    json!([{ "text": text }])
                };
                self.notify(
                    "textDocument/didChange",
                    json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": changes }),
                )?;
            }
        } else if opened {
            self.notify(
                "textDocument/didOpen",
                json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": version, "text": text } }),
            )?;
        }
        if opened && self.sync.save {
            let params = if self.sync.include_text {
                json!({ "textDocument": { "uri": uri }, "text": text })
            } else {
                json!({ "textDocument": { "uri": uri } })
            };
            self.notify("textDocument/didSave", params)?;
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

    fn close(mut self) -> napi::Result<()> {
        let mut failures = Vec::new();
        let never_cancelled = std::sync::atomic::AtomicBool::new(false);
        if self.child.try_wait().ok().flatten().is_none() {
            if let Err(error) = self.request("shutdown", Value::Null, &never_cancelled) {
                failures.push(error.to_string());
            }
            if let Err(error) = self.notify("exit", Value::Null) {
                failures.push(error.to_string());
            }
            terminate_process_tree(&mut self.child, false);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match self.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(20))
                    }
                    Ok(None) => {
                        terminate_process_tree(&mut self.child, true);
                        let _ = self.child.wait();
                        break;
                    }
                    Err(error) => {
                        failures.push(error.to_string());
                        terminate_process_tree(&mut self.child, true);
                        break;
                    }
                }
            }
        }
        if failures.is_empty() {
            return Ok(());
        }
        Err(failed(failures.join("; ")))
    }
}

fn terminate_process_tree(child: &mut Child, force: bool) {
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
    let lines = text.split(['\r', '\n']).collect::<Vec<_>>();
    json!({
        "line": lines.len().saturating_sub(1),
        "character": lines.last().map_or(0, |line| line.encode_utf16().count())
    })
}

fn parse_query(request: &str) -> napi::Result<Query> {
    let query: Query = serde_json::from_str(request)
        .map_err(|error| invalid(format!("invalid native LSP request: {error}")))?;
    let operations = [
        "definition",
        "references",
        "hover",
        "document_symbols",
        "workspace_symbols",
        "implementation",
        "incoming_calls",
        "outgoing_calls",
        "diagnostics",
    ];
    if !operations.contains(&query.operation.as_str()) {
        return Err(invalid(format!(
            "operation must be one of: {}",
            operations.join(", ")
        )));
    }
    if query.file_path.is_empty() {
        return Err(invalid("file_path is required"));
    }
    let needs_position = matches!(
        query.operation.as_str(),
        "definition"
            | "references"
            | "hover"
            | "implementation"
            | "incoming_calls"
            | "outgoing_calls"
    );
    if needs_position
        && (query.line.is_none_or(|line| line == 0)
            || query.column.is_none_or(|column| column == 0))
    {
        return Err(invalid(format!(
            "{} requires positive line and column",
            query.operation
        )));
    }
    if query.operation == "workspace_symbols"
        && query
            .query
            .as_ref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(invalid("query is required for workspace_symbols"));
    }
    Ok(query)
}

fn absolute_path(file_path: &str, cwd: &str) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    }
}

fn match_server(
    definitions: &[ServerDefinition],
    path: &Path,
) -> napi::Result<(ServerConfig, String, String)> {
    let display = path.to_string_lossy();
    let mut selected = None;
    for definition in definitions {
        let ServerDefinition::Enabled { server } = definition else {
            continue;
        };
        for (suffix, language_id) in &server.file_types {
            if display.ends_with(suffix)
                && selected.as_ref().is_none_or(
                    |(current, _, _): &(String, String, ServerConfig)| suffix.len() > current.len(),
                )
            {
                selected = Some((suffix.clone(), language_id.clone(), (**server).clone()));
            }
        }
    }
    selected
        .map(|(suffix, language_id, config)| (config, language_id, suffix))
        .ok_or_else(|| {
            failed(format!(
                "no language server supports {}; configure pluginConfig.lsp.servers",
                path.display()
            ))
        })
}

fn manager_query(
    state: &Arc<Mutex<ManagerState>>,
    request: &str,
    cwd: &str,
    cancelled_flag: &std::sync::atomic::AtomicBool,
) -> napi::Result<String> {
    let query = parse_query(request)?;
    cancelled(cancelled_flag)?;
    let path = absolute_path(&query.file_path, cwd);
    let metadata = fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            return failed(format!("File not found: {}", query.file_path));
        }
        failed(format!("Cannot inspect {}: {error}", query.file_path))
    })?;
    if !metadata.is_file() {
        return Err(failed(format!("Path is not a file: {}", query.file_path)));
    }
    let path = fs::canonicalize(&path).map_err(|error| failed(error.to_string()))?;
    let cwd_path = absolute_path(".", cwd);
    let (config, language_id, suffix) = {
        let manager = lock(state);
        if manager.closing {
            return Err(failed("language server manager is shutting down"));
        }
        match_server(&manager.definitions, &path)?
    };
    let root = server_root(&path, &cwd_path, &config.root_markers)?;
    let key = client_key(&config.id, &root);
    let client = {
        let mut manager = lock(state);
        if let Some(client) = manager.clients.get(&key) {
            client.clone()
        } else {
            let command = executable(&config, &root).ok_or_else(|| {
                failed(format!(
                    "LSP server {} is unavailable for {suffix}: {}",
                    config.id,
                    unavailable_reason(&config)
                ))
            })?;
            let client = RpcClient::start(
                &config,
                &root,
                &command,
                &manager.app_name,
                &manager.app_version,
                cancelled_flag,
            )
            .inspect_err(|error| {
                manager.failures.insert(
                    key.clone(),
                    (config.id.clone(), root.clone(), error.to_string()),
                );
            })?;
            let client = Arc::new(Mutex::new(client));
            manager.clients.insert(key.clone(), client.clone());
            manager.failures.remove(&key);
            client
        }
    };
    let result = {
        let mut client = lock(&client);
        query_client(
            &mut client,
            &language_id,
            &path,
            &query,
            cwd,
            cancelled_flag,
        )
    };
    if result.is_err() && lock(&client).failed.is_some() {
        let mut manager = lock(state);
        manager.clients.remove(&key);
        let reason = lock(&client)
            .failed
            .clone()
            .unwrap_or_else(|| "language server failed".to_owned());
        manager
            .failures
            .insert(key, (config.id.clone(), root, reason));
    }
    result
}

fn query_client(
    client: &mut RpcClient,
    language_id: &str,
    path: &Path,
    query: &Query,
    cwd: &str,
    cancelled_flag: &std::sync::atomic::AtomicBool,
) -> napi::Result<String> {
    let (uri, version, changed) = client.sync_document(path, language_id, cancelled_flag)?;
    if changed && query.operation != "diagnostics" {
        let _ = client.drain_until(
            Instant::now() + Duration::from_millis(1500),
            cancelled_flag,
            Some((path, version)),
        )?;
    }
    let position = || {
        json!({
            "textDocument": { "uri": uri },
            "position": {
                "line": query.line.unwrap_or(1) - 1,
                "character": query.column.unwrap_or(1) - 1
            }
        })
    };
    match query.operation.as_str() {
        "definition" => format_locations(
            &client.request("textDocument/definition", position(), cancelled_flag)?,
            cwd,
            "definition",
            "definitions",
        ),
        "references" => format_locations(
            &client.request(
                "textDocument/references",
                json!({
                    "textDocument": { "uri": uri },
                    "position": position()["position"].clone(),
                    "context": { "includeDeclaration": true }
                }),
                cancelled_flag,
            )?,
            cwd,
            "reference",
            "references",
        ),
        "hover" => {
            format_hover(&client.request("textDocument/hover", position(), cancelled_flag)?)
        }
        "document_symbols" => format_symbols(
            &client.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                cancelled_flag,
            )?,
            cwd,
            &uri,
        ),
        "workspace_symbols" => format_symbols(
            &client.request(
                "workspace/symbol",
                json!({ "query": query.query.as_deref().unwrap_or("") }),
                cancelled_flag,
            )?,
            cwd,
            &uri,
        ),
        "implementation" => format_locations(
            &client.request("textDocument/implementation", position(), cancelled_flag)?,
            cwd,
            "implementation",
            "implementations",
        ),
        "incoming_calls" | "outgoing_calls" => {
            let prepared = client.request(
                "textDocument/prepareCallHierarchy",
                position(),
                cancelled_flag,
            )?;
            let item = first_item(&prepared);
            let direction = if query.operation == "incoming_calls" {
                "incoming"
            } else {
                "outgoing"
            };
            let Some(item) = item else {
                return Ok(format!("No {direction} calls found"));
            };
            format_calls(
                &client.request(
                    &format!("callHierarchy/{direction}Calls"),
                    json!({ "item": item }),
                    cancelled_flag,
                )?,
                cwd,
                direction,
            )
        }
        "diagnostics" => {
            if client
                .capabilities
                .get("diagnosticProvider")
                .is_some_and(|value| value != false)
            {
                let result = client.request(
                    "textDocument/diagnostic",
                    json!({ "textDocument": { "uri": uri } }),
                    cancelled_flag,
                )?;
                let items = result
                    .get("items")
                    .and_then(Value::as_array)
                    .ok_or_else(|| failed("language server returned malformed pull diagnostics"))?;
                return format_diagnostics(items, &uri, cwd);
            }
            let published = client.drain_until(
                Instant::now() + Duration::from_millis(1500),
                cancelled_flag,
                Some((path, version)),
            )?;
            if !published {
                return Ok(
                    "No diagnostics received from the language server before the 1.5s deadline"
                        .to_owned(),
                );
            }
            let items = client
                .diagnostics
                .get(path)
                .map(|(_, items)| items.as_slice())
                .unwrap_or_default();
            format_diagnostics(items, &uri, cwd)
        }
        _ => Err(invalid("invalid LSP operation")),
    }
}

fn values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(values) => values.iter().collect(),
        value => vec![value],
    }
}

type Point = (u64, u64);
type Range = (Point, Point);
type Location = (String, Range);
type CallItem = (String, String, String, Range);

fn position(value: &Value) -> Option<Point> {
    let object = value.as_object()?;
    Some((
        object.get("line")?.as_u64()?,
        object.get("character")?.as_u64()?,
    ))
}

fn range(value: &Value) -> Option<Range> {
    Some((position(value.get("start")?)?, position(value.get("end")?)?))
}

fn location(value: &Value) -> Option<Location> {
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))?
        .as_str()?
        .to_owned();
    let at = value
        .get("range")
        .and_then(range)
        .or_else(|| value.get("targetSelectionRange").and_then(range))
        .or_else(|| value.get("targetRange").and_then(range))?;
    Some((uri, at))
}

fn display_path(uri: &str, cwd: &str) -> String {
    let Some(path) = uri_path(uri) else {
        return uri.to_owned();
    };
    let cwd = Path::new(cwd);
    path.strip_prefix(cwd)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map_or_else(
            || path.display().to_string(),
            |relative| relative.display().to_string(),
        )
}

fn location_text(uri: &str, at: Range, cwd: &str) -> String {
    format!(
        "{}:{}:{}-{}:{}",
        display_path(uri, cwd),
        at.0.0 + 1,
        at.0.1 + 1,
        at.1.0 + 1,
        at.1.1 + 1
    )
}

fn bounded(header: String, lines: Vec<String>) -> String {
    if lines.len() <= MAX_ITEMS {
        return std::iter::once(header)
            .chain(lines)
            .collect::<Vec<_>>()
            .join("\n");
    }
    let omitted = lines.len() - MAX_ITEMS;
    std::iter::once(header)
        .chain(lines.into_iter().take(MAX_ITEMS))
        .chain(std::iter::once(format!(
            "... {omitted} more results omitted"
        )))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_locations(
    value: &Value,
    cwd: &str,
    singular: &str,
    plural: &str,
) -> napi::Result<String> {
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    for value in values(value) {
        let (uri, at) = location(value).ok_or_else(|| {
            failed(format!(
                "language server returned a malformed {singular} result"
            ))
        })?;
        let line = location_text(&uri, at, cwd);
        if seen.insert(line.clone()) {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        return Ok(format!("No {plural} found"));
    }
    let label = if lines.len() == 1 { singular } else { plural };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

fn hover_part(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let text = value.get("value")?.as_str()?;
    let language = value.get("language").and_then(Value::as_str);
    Some(language.map_or_else(
        || text.to_owned(),
        |language| format!("```{language}\n{text}\n```"),
    ))
}

fn format_hover(value: &Value) -> napi::Result<String> {
    if value.is_null() {
        return Ok("No hover information found".to_owned());
    }
    let contents = value
        .get("contents")
        .ok_or_else(|| failed("language server returned a malformed hover result"))?;
    let mut parts = Vec::new();
    for value in values(contents) {
        let part = hover_part(value)
            .ok_or_else(|| failed("language server returned a malformed hover result"))?;
        if !part.is_empty() {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        return Ok("No hover information found".to_owned());
    }
    Ok(format!("Hover information\n{}", parts.join("\n\n")))
}

const SYMBOL_KINDS: [&str; 26] = [
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "Enum member",
    "Struct",
    "Event",
    "Operator",
    "Type parameter",
];

fn symbol_kind(value: &Value) -> Option<String> {
    let kind = value.as_u64()?;
    if kind == 0 {
        return None;
    }
    Some(
        SYMBOL_KINDS
            .get(kind as usize - 1)
            .map_or_else(|| format!("Symbol {kind}"), |value| (*value).to_owned()),
    )
}

fn symbol_lines(
    value: &Value,
    cwd: &str,
    fallback_uri: &str,
    depth: usize,
) -> napi::Result<Vec<String>> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
    let kind = value
        .get("kind")
        .and_then(symbol_kind)
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
    let at = value
        .get("selectionRange")
        .and_then(range)
        .or_else(|| value.get("range").and_then(range));
    let (uri, at) = if let Some(at) = at {
        (fallback_uri.to_owned(), at)
    } else {
        location(
            value
                .get("location")
                .ok_or_else(|| failed("language server returned a malformed symbol result"))?,
        )
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?
    };
    let detail = value
        .get("detail")
        .or_else(|| value.get("containerName"))
        .and_then(Value::as_str)
        .map(|detail| format!(" — {detail}"))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "{}{} · {kind} · {name}{detail}",
        "  ".repeat(depth),
        location_text(&uri, at, cwd)
    )];
    if let Some(children) = value.get("children") {
        let children = children
            .as_array()
            .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
        for child in children {
            lines.extend(symbol_lines(child, cwd, fallback_uri, depth + 1)?);
        }
    }
    Ok(lines)
}

fn format_symbols(value: &Value, cwd: &str, fallback_uri: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in values(value) {
        lines.extend(symbol_lines(value, cwd, fallback_uri, 0)?);
    }
    if lines.is_empty() {
        return Ok("No symbols found".to_owned());
    }
    let label = if lines.len() == 1 {
        "symbol"
    } else {
        "symbols"
    };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

fn first_item(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(values) => values.first().cloned(),
        value => Some(value.clone()),
    }
}

fn call_item(value: &Value) -> Option<CallItem> {
    let name = value.get("name")?.as_str()?.to_owned();
    let uri = value.get("uri")?.as_str()?.to_owned();
    let at = range(value.get("selectionRange")?)?;
    range(value.get("range")?)?;
    let kind = symbol_kind(value.get("kind")?)?;
    Some((name, kind, uri, at))
}

fn format_calls(value: &Value, cwd: &str, direction: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in values(value) {
        let target = if direction == "incoming" {
            value.get("from")
        } else {
            value.get("to")
        }
        .and_then(call_item)
        .ok_or_else(|| failed("language server returned a malformed call hierarchy result"))?;
        lines.push(format!(
            "{} · {} · {}",
            location_text(&target.2, target.3, cwd),
            target.1,
            target.0
        ));
    }
    if lines.is_empty() {
        return Ok(format!("No {direction} calls found"));
    }
    let label = if lines.len() == 1 { "call" } else { "calls" };
    Ok(bounded(
        format!("Found {} {direction} {label}", lines.len()),
        lines,
    ))
}

fn format_diagnostics(items: &[Value], uri: &str, cwd: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in items {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| failed("language server returned a malformed diagnostic result"))?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let message = if message.is_empty() {
            "(empty message)".to_owned()
        } else {
            message
        };
        let at = value
            .get("range")
            .and_then(range)
            .ok_or_else(|| failed("language server returned a malformed diagnostic result"))?;
        let severity = match value.get("severity").and_then(Value::as_u64) {
            Some(1) => "error",
            Some(2) => "warning",
            Some(3) => "information",
            Some(4) => "hint",
            _ => "diagnostic",
        };
        let source = value.get("source").and_then(Value::as_str);
        let code = value.get("code").and_then(|code| {
            code.as_str()
                .map(str::to_owned)
                .or_else(|| code.as_i64().map(|value| value.to_string()))
                .or_else(|| {
                    code.get("value").and_then(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .or_else(|| value.as_i64().map(|value| value.to_string()))
                    })
                })
        });
        let label = [source.map(str::to_owned), code]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let label = if label.is_empty() {
            String::new()
        } else {
            format!(" [{label}]")
        };
        lines.push(format!(
            "{}: {severity}{label}: {message}",
            location_text(uri, at, cwd)
        ));
    }
    if lines.is_empty() {
        return Ok("No diagnostics found".to_owned());
    }
    let label = if lines.len() == 1 {
        "diagnostic"
    } else {
        "diagnostics"
    };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

pub struct QueryTask {
    state: Arc<Mutex<ManagerState>>,
    request: String,
    cwd: String,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

impl Task for QueryTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        manager_query(&self.state, &self.request, &self.cwd, &self.cancelled)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct ActionTask {
    state: Arc<Mutex<ManagerState>>,
    action: Action,
}

enum Action {
    Restart(Option<String>),
    Close,
}

impl Task for ActionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let clients = {
            let mut manager = lock(&self.state);
            match &self.action {
                Action::Restart(server) => {
                    if manager.closing {
                        return Err(failed("language server manager is shutting down"));
                    }
                    if let Some(server) = server {
                        let definition =
                            manager
                                .definitions
                                .iter()
                                .find(|definition| match definition {
                                    ServerDefinition::Enabled { server: config } => {
                                        config.id == *server
                                    }
                                    ServerDefinition::Disabled { id } => id == server,
                                });
                        match definition {
                            None => {
                                return Err(failed(format!("unknown language server: {server}")));
                            }
                            Some(ServerDefinition::Disabled { .. }) => {
                                return Err(failed(format!(
                                    "language server is disabled: {server}"
                                )));
                            }
                            Some(ServerDefinition::Enabled { .. }) => {}
                        }
                    }
                    manager
                        .failures
                        .retain(|_, (id, _, _)| server.as_ref().is_some_and(|server| id != server));
                    let keys = manager
                        .clients
                        .iter()
                        .filter(|(_, client)| {
                            server
                                .as_ref()
                                .is_none_or(|server| lock(client).id == *server)
                        })
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    keys.into_iter()
                        .filter_map(|key| manager.clients.remove(&key))
                        .collect::<Vec<_>>()
                }
                Action::Close => {
                    manager.closing = true;
                    manager.failures.clear();
                    manager.clients.drain().map(|(_, client)| client).collect()
                }
            }
        };
        let mut failures = Vec::new();
        for client in clients {
            let client = Arc::try_unwrap(client)
                .map_err(|_| failed("language server is still in use during shutdown"))?
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Err(error) = client.close() {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            return Ok(());
        }
        let operation = match self.action {
            Action::Restart(_) => "restart",
            Action::Close => "shutdown",
        };
        Err(failed(format!(
            "language server {operation} failed: {}",
            failures.join("; ")
        )))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
impl NativeLspManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(definitions: String, app_name: String, app_version: String) -> napi::Result<Self> {
        let definitions = serde_json::from_str(&definitions)
            .map_err(|error| invalid(format!("invalid native LSP configuration: {error}")))?;
        Ok(Self {
            state: Arc::new(Mutex::new(ManagerState {
                definitions,
                clients: HashMap::new(),
                failures: HashMap::new(),
                closing: false,
                app_name,
                app_version,
            })),
        })
    }

    #[napi(catch_unwind)]
    pub fn has_available_server(&self, cwd: String) -> bool {
        let manager = lock(&self.state);
        if !manager.clients.is_empty() {
            return true;
        }
        manager.definitions.iter().any(|definition| {
            let ServerDefinition::Enabled { server } = definition else {
                return false;
            };
            executable(server, Path::new(&cwd)).is_some() || may_resolve_from_another_root(server)
        })
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, cwd: String) -> Vec<String> {
        let manager = lock(&self.state);
        if manager.definitions.is_empty() {
            return vec!["No language servers configured.".to_owned()];
        }
        let mut lines = Vec::new();
        for definition in &manager.definitions {
            let ServerDefinition::Enabled { server } = definition else {
                let ServerDefinition::Disabled { id } = definition else {
                    unreachable!();
                };
                lines.push(format!("{id} · disabled"));
                continue;
            };
            let active = manager
                .clients
                .values()
                .filter(|client| lock(client).id == server.id)
                .cloned()
                .collect::<Vec<_>>();
            let failures = manager
                .failures
                .values()
                .filter(|(id, _, _)| *id == server.id)
                .collect::<Vec<_>>();
            if active.is_empty() && failures.is_empty() {
                let suffixes = server
                    .file_types
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                if executable(server, Path::new(&cwd)).is_none() {
                    lines.push(format!(
                        "{} · unavailable · {suffixes} · {}",
                        server.id,
                        unavailable_reason(server)
                    ));
                } else {
                    lines.push(format!(
                        "{} · idle · {suffixes} · {}",
                        server.id, server.command
                    ));
                }
                continue;
            }
            for client in active {
                let client = lock(&client);
                let stderr = client.stderr();
                lines.push(
                    [
                        client.id.clone(),
                        "ready".to_owned(),
                        client.root.display().to_string(),
                        client.failed.clone().unwrap_or_default(),
                        stderr,
                    ]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                );
            }
            for (_, root, reason) in failures {
                lines.push(format!(
                    "{} · failed · {} · {reason}",
                    server.id,
                    root.display()
                ));
            }
        }
        lines
    }

    #[napi(catch_unwind)]
    pub fn query(
        &self,
        request: String,
        cwd: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<QueryTask> {
        AsyncTask::new(QueryTask {
            state: self.state.clone(),
            request,
            cwd,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn restart(&self, server: Option<String>) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            state: self.state.clone(),
            action: Action::Restart(server),
        })
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            state: self.state.clone(),
            action: Action::Close,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{format_diagnostics, format_hover, format_locations, parse_query};
    use serde_json::json;

    #[test]
    fn validates_queries() {
        assert!(
            parse_query(r#"{"operation":"hover","filePath":"a.ts","line":1,"column":1}"#).is_ok()
        );
        assert!(parse_query(r#"{"operation":"hover","filePath":"a.ts"}"#).is_err());
        assert!(
            parse_query(r#"{"operation":"workspace_symbols","filePath":"a.ts","query":"x"}"#)
                .is_ok()
        );
    }

    #[test]
    fn formats_locations_and_hover() {
        let value = json!({
            "uri": "file:///tmp/a.ts",
            "range": {
                "start": { "line": 0, "character": 1 },
                "end": { "line": 0, "character": 2 }
            }
        });
        assert_eq!(
            format_locations(&value, "/tmp", "definition", "definitions").unwrap(),
            "Found 1 definition\na.ts:1:2-1:3"
        );
        assert_eq!(
            format_hover(&json!({ "contents": "hello" })).unwrap(),
            "Hover information\nhello"
        );
    }

    #[test]
    fn formats_diagnostic() {
        let items = vec![json!({
            "range": {
                "start": { "line": 1, "character": 2 },
                "end": { "line": 1, "character": 3 }
            },
            "severity": 1,
            "message": "bad"
        })];
        assert_eq!(
            format_diagnostics(&items, "file:///tmp/a.ts", "/tmp").unwrap(),
            "Found 1 diagnostic\na.ts:2:3-2:4: error: bad"
        );
    }
}
