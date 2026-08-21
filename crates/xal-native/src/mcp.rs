#![cfg_attr(test, allow(dead_code))]

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Duration;

use futures_util::StreamExt;
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use rmcp::ServiceExt;
use rmcp::handler::client::ClientHandler;
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, ClientCapabilities, ClientInfo, ClientRequest,
    Implementation, PaginatedRequestParams, ProgressNotificationParam, Prompt,
    ReadResourceRequestParams, Resource, ResourceTemplate, ServerResult, Tool,
};
use rmcp::service::{
    NotificationContext, Peer, PeerRequestOptions, RoleClient, RunningService, RxJsonRpcMessage,
    TxJsonRpcMessage,
};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess, Transport};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::runtime::Runtime;

use crate::tool_contracts::cancellation_flag;

const PROGRESS_CAPACITY: usize = 32;
const MAX_ITEMS_PER_CATALOG: usize = 100_000;
const MAX_LEGACY_SSE_BUFFER_BYTES: usize = 16 * 1024 * 1024;

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

#[derive(Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
enum ServerConfig {
    Stdio {
        id: String,
        enabled: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cwd: Option<PathBuf>,
    },
    Http {
        id: String,
        enabled: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

impl ServerConfig {
    fn id(&self) -> &str {
        match self {
            Self::Stdio { id, .. } | Self::Http { id, .. } => id,
        }
    }

    fn enabled(&self) -> bool {
        match self {
            Self::Stdio { enabled, .. } | Self::Http { enabled, .. } => *enabled,
        }
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(match self {
            Self::Stdio { timeout_ms, .. } | Self::Http { timeout_ms, .. } => *timeout_ms,
        })
    }

    fn transport(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
        }
    }
}

#[derive(Default)]
struct ProgressEvent {
    progress: f64,
    text: String,
}

#[derive(Default)]
struct HandlerState {
    tool_revision: AtomicU64,
    resource_revision: AtomicU64,
    prompt_revision: AtomicU64,
    progress: Mutex<HashMap<String, mpsc::SyncSender<ProgressEvent>>>,
}

#[derive(Clone)]
struct Handler {
    state: Arc<HandlerState>,
    info: ClientInfo,
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }

    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        let key = serde_json::to_string(&params.progress_token).unwrap_or_default();
        let sender = lock(&self.state.progress).get(&key).cloned();
        if let Some(sender) = sender {
            let event = ProgressEvent {
                progress: params.progress,
                text: progress_text(&params),
            };
            let _ = sender.try_send(event);
        }
        std::future::ready(())
    }

    fn on_tool_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.tool_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }

    fn on_resource_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.resource_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }

    fn on_prompt_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl Future<Output = ()> + Send + '_ {
        self.state.prompt_revision.fetch_add(1, Ordering::Relaxed);
        std::future::ready(())
    }
}

struct ToolRecord {
    remote: Tool,
    native_name: String,
    output_schema: Option<Value>,
}

struct Entry {
    config: ServerConfig,
    state: String,
    connection_transport: Option<String>,
    service: Option<RunningService<RoleClient, Handler>>,
    peer: Option<Peer<RoleClient>>,
    handler: Arc<HandlerState>,
    tools: Vec<ToolRecord>,
    resources: Vec<Value>,
    templates: Vec<Value>,
    prompts: Vec<Value>,
    instructions: Option<String>,
    error: Option<String>,
    skipped_task_tools: Vec<String>,
    skipped_output_tools: Vec<String>,
    seen_tool_revision: u64,
    seen_resource_revision: u64,
    seen_prompt_revision: u64,
    generation: u64,
}

struct ManagerState {
    entries: HashMap<String, Entry>,
    order: Vec<String>,
    closing: bool,
    tool_revision: u64,
    app_name: String,
    app_version: String,
}

#[napi]
pub struct NativeMcpManager {
    state: Arc<Mutex<ManagerState>>,
    runtime: Arc<Runtime>,
}

fn client_info(name: String, version: String) -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new(name, version),
    )
}

async fn timeout<T>(
    duration: Duration,
    label: &str,
    future: impl Future<Output = Result<T, impl std::fmt::Display>>,
) -> napi::Result<T> {
    match tokio::time::timeout(duration, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(failed(error.to_string())),
        Err(_) => Err(failed(format!(
            "{label} timed out after {}ms",
            duration.as_millis()
        ))),
    }
}

async fn cancellable<T>(
    duration: Duration,
    label: &str,
    cancelled: &AtomicBool,
    future: impl Future<Output = Result<T, impl std::fmt::Display>>,
) -> napi::Result<T> {
    tokio::pin!(future);
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut future => return result.map_err(|error| failed(error.to_string())),
            () = &mut deadline => return Err(failed(format!("{label} timed out after {}ms", duration.as_millis()))),
            () = tokio::time::sleep(Duration::from_millis(20)) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(failed(format!("{label} was cancelled")));
                }
            }
        }
    }
}

struct SseEvent {
    event: String,
    data: String,
}

fn extend_sse_buffer(buffer: &mut Vec<u8>, chunk: &[u8]) -> napi::Result<()> {
    if buffer.len().saturating_add(chunk.len()) > MAX_LEGACY_SSE_BUFFER_BYTES {
        return Err(failed(format!(
            "legacy MCP SSE event exceeds {MAX_LEGACY_SSE_BUFFER_BYTES} bytes"
        )));
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn take_sse_event(buffer: &mut Vec<u8>) -> napi::Result<Option<SseEvent>> {
    let newline = buffer.windows(2).position(|window| window == b"\n\n");
    let carriage = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    let (index, delimiter) = match (newline, carriage) {
        (Some(left), Some(right)) if left <= right => (left, 2),
        (Some(_), Some(right)) => (right, 4),
        (Some(left), None) => (left, 2),
        (None, Some(right)) => (right, 4),
        (None, None) => return Ok(None),
    };
    let bytes = buffer.drain(..index + delimiter).collect::<Vec<_>>();
    let text = std::str::from_utf8(&bytes[..index])
        .map_err(|error| failed(format!("legacy MCP SSE is not UTF-8: {error}")))?;
    let mut event = "message".to_owned();
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim_start().to_owned();
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    Ok(Some(SseEvent {
        event,
        data: data.join("\n"),
    }))
}

async fn process_sse_buffer(
    buffer: &mut Vec<u8>,
    sender: &tokio::sync::mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
) -> napi::Result<()> {
    while let Some(event) = take_sse_event(buffer)? {
        if event.event != "message" || event.data.is_empty() {
            continue;
        }
        let message = serde_json::from_str(&event.data)
            .map_err(|error| failed(format!("invalid legacy MCP SSE message: {error}")))?;
        if sender.send(message).await.is_err() {
            return Ok(());
        }
    }
    Ok(())
}

struct LegacySseTransport {
    client: reqwest13::Client,
    endpoint: reqwest13::Url,
    headers: reqwest13::header::HeaderMap,
    receiver: tokio::sync::mpsc::Receiver<RxJsonRpcMessage<RoleClient>>,
    reader: tokio::task::JoinHandle<()>,
}

impl LegacySseTransport {
    async fn connect(url: &str, headers: reqwest13::header::HeaderMap) -> napi::Result<Self> {
        let client = reqwest13::Client::builder()
            .build()
            .map_err(|error| failed(error.to_string()))?;
        let response = client
            .get(url)
            .headers(headers.clone())
            .header(reqwest13::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|error| failed(format!("legacy MCP SSE connection failed: {error}")))?
            .error_for_status()
            .map_err(|error| failed(format!("legacy MCP SSE connection failed: {error}")))?;
        let base = response.url().clone();
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let endpoint = loop {
            let chunk = stream
                .next()
                .await
                .ok_or_else(|| failed("legacy MCP SSE closed before announcing an endpoint"))?
                .map_err(|error| failed(format!("legacy MCP SSE failed: {error}")))?;
            extend_sse_buffer(&mut buffer, &chunk)?;
            let mut endpoint = None;
            while let Some(event) = take_sse_event(&mut buffer)? {
                if event.event == "endpoint" {
                    endpoint = Some(base.join(&event.data).map_err(|error| {
                        failed(format!("invalid legacy MCP endpoint: {error}"))
                    })?);
                    break;
                }
            }
            if let Some(endpoint) = endpoint {
                break endpoint;
            }
        };
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let reader = tokio::spawn(async move {
            if process_sse_buffer(&mut buffer, &sender).await.is_err() {
                return;
            }
            while let Some(chunk) = stream.next().await {
                let Ok(chunk) = chunk else {
                    return;
                };
                if extend_sse_buffer(&mut buffer, &chunk).is_err()
                    || process_sse_buffer(&mut buffer, &sender).await.is_err()
                {
                    return;
                }
            }
        });
        Ok(Self {
            client,
            endpoint,
            headers,
            receiver,
            reader,
        })
    }
}

impl Transport<RoleClient> for LegacySseTransport {
    type Error = std::io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let client = self.client.clone();
        let endpoint = self.endpoint.clone();
        let headers = self.headers.clone();
        async move {
            client
                .post(endpoint)
                .headers(headers)
                .header(reqwest13::header::CONTENT_TYPE, "application/json")
                .json(&item)
                .send()
                .await
                .map_err(std::io::Error::other)?
                .error_for_status()
                .map_err(std::io::Error::other)?;
            Ok(())
        }
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.receiver.recv()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.reader.abort();
        std::future::ready(Ok(()))
    }
}

async fn connect_service(
    config: &ServerConfig,
    handler: Handler,
    cancelled: &AtomicBool,
) -> napi::Result<(RunningService<RoleClient, Handler>, String)> {
    match config {
        ServerConfig::Stdio {
            command,
            args,
            env,
            cwd,
            ..
        } => {
            let mut process = tokio::process::Command::new(command);
            process
                .args(args)
                .envs(env)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            if let Some(cwd) = cwd {
                process.current_dir(cwd);
            }
            let transport = TokioChildProcess::new(process)
                .map_err(|error| failed(format!("failed to launch MCP server: {error}")))?;
            let service = cancellable(
                config.timeout(),
                "MCP connection",
                cancelled,
                handler.serve(transport),
            )
            .await?;
            Ok((service, "stdio".to_owned()))
        }
        ServerConfig::Http { url, headers, .. } => {
            let mut parsed_headers = reqwest13::header::HeaderMap::new();
            for (name, value) in headers {
                let name = reqwest13::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|error| invalid(format!("invalid MCP header {name}: {error}")))?;
                let value = reqwest13::header::HeaderValue::from_str(value)
                    .map_err(|error| invalid(format!("invalid MCP header value: {error}")))?;
                parsed_headers.insert(name, value);
            }
            let client = reqwest13::Client::builder()
                .build()
                .map_err(|error| failed(error.to_string()))?;
            let transport = StreamableHttpClientTransport::with_client(
                client,
                StreamableHttpClientTransportConfig::with_uri(url.clone()).custom_headers(
                    parsed_headers
                        .iter()
                        .map(|(name, value)| (name.clone(), value.clone()))
                        .collect(),
                ),
            );
            let http = cancellable(
                config.timeout(),
                "MCP connection",
                cancelled,
                handler.clone().serve(transport),
            )
            .await;
            match http {
                Ok(service) => Ok((service, "http".to_owned())),
                Err(http_error) => {
                    let http_reason = http_error.to_string();
                    if !http_reason.contains("HTTP 4") || !http_reason.contains("initialize") {
                        return Err(failed(format!("streamable HTTP failed: {http_reason}")));
                    }
                    let transport = cancellable(
                        config.timeout(),
                        "legacy MCP connection",
                        cancelled,
                        LegacySseTransport::connect(url, parsed_headers),
                    )
                    .await
                    .map_err(|sse_error| {
                        failed(format!(
                            "streamable HTTP failed: {http_error}; SSE fallback failed: {sse_error}"
                        ))
                    })?;
                    let service = cancellable(
                        config.timeout(),
                        "legacy MCP connection",
                        cancelled,
                        handler.serve(transport),
                    )
                    .await
                    .map_err(|sse_error| {
                        failed(format!(
                            "streamable HTTP failed: {http_error}; SSE fallback failed: {sse_error}"
                        ))
                    })?;
                    Ok((service, "sse".to_owned()))
                }
            }
        }
    }
}

fn capabilities(peer: &Peer<RoleClient>) -> Value {
    peer.peer_info()
        .and_then(|info| serde_json::to_value(&info.capabilities).ok())
        .unwrap_or_else(|| json!({}))
}

fn has_capability(peer: &Peer<RoleClient>, capability: &str) -> bool {
    capabilities(peer).get(capability).is_some()
}

async fn list_tools(peer: &Peer<RoleClient>, duration: Duration) -> napi::Result<Vec<Tool>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_tools(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.tools);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP tools catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP tools listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP tools listing", run).await
}

async fn list_resources(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<Resource>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_resources(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.resources);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP resources catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP resources listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP resources listing", run).await
}

async fn list_templates(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<ResourceTemplate>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_resource_templates(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.resource_templates);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed(
                    "MCP resource templates catalog exceeds 100000 entries",
                ));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP resource templates listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP resource templates listing", run).await
}

async fn list_prompts(peer: &Peer<RoleClient>, duration: Duration) -> napi::Result<Vec<Prompt>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_prompts(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.prompts);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP prompts catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP prompts listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP prompts listing", run).await
}

fn json_values<T: serde::Serialize>(values: &[T]) -> napi::Result<Vec<Value>> {
    values
        .iter()
        .map(|value| serde_json::to_value(value).map_err(|error| failed(error.to_string())))
        .collect()
}

fn native_tool_name(server: &str, tool: &str) -> String {
    let normalized = tool
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let normalized = if normalized.is_empty() {
        "tool".to_owned()
    } else {
        normalized
    };
    let base = format!("mcp__{server}__{normalized}");
    if normalized == tool && base.encode_utf16().count() <= 64 {
        return base;
    }
    let suffix = fnv_hash(&format!("{server}\0{tool}"));
    let maximum = 63_usize.saturating_sub(suffix.len());
    let prefix = base.encode_utf16().take(maximum).collect::<Vec<_>>();
    format!("{}_{}", String::from_utf16_lossy(&prefix), suffix)
}

fn fnv_hash(value: &str) -> String {
    let mut result = 2_166_136_261_u32;
    for unit in value.encode_utf16() {
        result = (result ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    radix36(result)
}

fn radix36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("radix output is ASCII")
}

fn validate_output_schema(name: &str, schema: &Map<String, Value>) -> napi::Result<Value> {
    let schema = Value::Object(schema.clone());
    if schema.get("$async") == Some(&Value::Bool(true)) {
        return Err(failed(format!(
            "MCP tool {name} uses an unsupported asynchronous output schema"
        )));
    }
    let dialect = schema
        .get("$schema")
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('#'));
    if let Some(dialect) = dialect
        && !dialect.ends_with("json-schema.org/draft-07/schema")
        && !dialect.ends_with("json-schema.org/draft/2019-09/schema")
        && !dialect.ends_with("json-schema.org/draft/2020-12/schema")
    {
        return Err(failed(format!(
            "MCP tool {name} uses unsupported output schema dialect {dialect}"
        )));
    }
    jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .map_err(|error| {
            failed(format!(
                "MCP tool {name} has an invalid output schema: {error}"
            ))
        })?;
    Ok(schema)
}

fn tool_records(
    server: &str,
    tools: Vec<Tool>,
) -> napi::Result<(Vec<ToolRecord>, Vec<String>, Vec<String>)> {
    let mut remote_names = HashSet::new();
    let mut native_names = HashSet::new();
    let mut records = Vec::new();
    let mut skipped_tasks = Vec::new();
    let mut skipped_output = Vec::new();
    for tool in tools {
        if !remote_names.insert(tool.name.to_string()) {
            return Err(failed(format!(
                "MCP server returned duplicate tool: {}",
                tool.name
            )));
        }
        let native_name = native_tool_name(server, &tool.name);
        if !native_names.insert(native_name.clone()) {
            return Err(failed(format!(
                "MCP tool names collide after normalization: {native_name}"
            )));
        }
        if tool
            .execution
            .as_ref()
            .and_then(|value| value.get("taskSupport"))
            .and_then(Value::as_str)
            == Some("required")
        {
            skipped_tasks.push(tool.name.to_string());
            continue;
        }
        let output_schema = match &tool.output_schema {
            Some(schema) => match validate_output_schema(&tool.name, schema) {
                Ok(schema) => Some(schema),
                Err(error) => {
                    skipped_output.push(format!("{}: {error}", tool.name));
                    continue;
                }
            },
            None => None,
        };
        records.push(ToolRecord {
            remote: tool,
            native_name,
            output_schema,
        });
    }
    Ok((records, skipped_tasks, skipped_output))
}

async fn discover(
    peer: &Peer<RoleClient>,
    config: &ServerConfig,
) -> napi::Result<(
    Vec<ToolRecord>,
    Vec<Value>,
    Vec<Value>,
    Vec<Value>,
    Vec<String>,
    Vec<String>,
)> {
    let duration = config.timeout();
    let server = config.id();
    let (tools, resources, templates, prompts) = tokio::join!(
        async {
            if has_capability(peer, "tools") {
                list_tools(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "resources") {
                list_resources(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "resources") {
                list_templates(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "prompts") {
                list_prompts(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        }
    );
    let (tools, skipped_tasks, skipped_output) = tool_records(server, tools?)?;
    Ok((
        tools,
        json_values(&resources?)?,
        json_values(&templates?)?,
        json_values(&prompts?)?,
        skipped_tasks,
        skipped_output,
    ))
}

async fn close_service(service: &mut RunningService<RoleClient, Handler>) -> napi::Result<()> {
    match service.close_with_timeout(Duration::from_secs(5)).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(failed("MCP connection close timed out after 5000ms")),
        Err(error) => Err(failed(format!("MCP connection close: {error}"))),
    }
}

async fn connect_entry(
    state: Arc<Mutex<ManagerState>>,
    id: String,
    cancelled: Arc<AtomicBool>,
) -> napi::Result<()> {
    let (config, generation, handler) = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let entry = manager
            .entries
            .get_mut(&id)
            .ok_or_else(|| failed(format!("unknown MCP server: {id}")))?;
        if !entry.config.enabled() {
            return Err(failed(format!("MCP server is disabled: {id}")));
        }
        entry.generation += 1;
        entry.state = "connecting".to_owned();
        entry.error = None;
        (
            entry.config.clone(),
            entry.generation,
            Handler {
                state: entry.handler.clone(),
                info: client_info(
                    format!("{}-{id}", manager.app_name),
                    manager.app_version.clone(),
                ),
            },
        )
    };
    let result = async {
        let (service, transport) = connect_service(&config, handler, &cancelled).await?;
        let peer = service.peer().clone();
        let discovered = cancellable(
            config.timeout(),
            "MCP discovery",
            &cancelled,
            discover(&peer, &config),
        )
        .await?;
        Ok::<_, Error>((service, peer, transport, discovered))
    }
    .await;
    let mut result = Some(result);
    let old_service = {
        let mut manager = lock(&state);
        let is_current = manager
            .entries
            .get(&id)
            .is_some_and(|entry| entry.generation == generation);
        if !is_current {
            result
                .take()
                .and_then(Result::ok)
                .map(|(service, _, _, _)| service)
        } else {
            let entry = manager.entries.get_mut(&id).expect("current entry exists");
            let old = match result.take().expect("connection result exists") {
                Ok((service, peer, transport, discovered)) => {
                    let old = entry.service.take();
                    entry.service = Some(service);
                    entry.peer = Some(peer.clone());
                    entry.connection_transport = Some(transport);
                    entry.state = "connected".to_owned();
                    entry.error = None;
                    entry.tools = discovered.0;
                    entry.resources = discovered.1;
                    entry.templates = discovered.2;
                    entry.prompts = discovered.3;
                    entry.skipped_task_tools = discovered.4;
                    entry.skipped_output_tools = discovered.5;
                    entry.instructions =
                        peer.peer_info().and_then(|info| info.instructions.clone());
                    entry.seen_tool_revision = entry.handler.tool_revision.load(Ordering::Relaxed);
                    entry.seen_resource_revision =
                        entry.handler.resource_revision.load(Ordering::Relaxed);
                    entry.seen_prompt_revision =
                        entry.handler.prompt_revision.load(Ordering::Relaxed);
                    old
                }
                Err(error) => {
                    let old = entry.service.take();
                    entry.peer = None;
                    entry.connection_transport = None;
                    entry.state = "failed".to_owned();
                    entry.error = Some(error.to_string());
                    entry.tools.clear();
                    entry.resources.clear();
                    entry.templates.clear();
                    entry.prompts.clear();
                    old
                }
            };
            manager.tool_revision += 1;
            old
        }
    };
    if let Some(mut service) = old_service {
        let _ = close_service(&mut service).await;
    }
    Ok(())
}

async fn refresh_entry(state: Arc<Mutex<ManagerState>>, id: String) -> napi::Result<()> {
    let (peer, config, generation, tool_changed, resource_changed, prompt_changed) = {
        let manager = lock(&state);
        let Some(entry) = manager.entries.get(&id) else {
            return Ok(());
        };
        if entry.state != "connected" {
            return Ok(());
        }
        let Some(peer) = entry.peer.clone() else {
            return Ok(());
        };
        (
            peer,
            entry.config.clone(),
            entry.generation,
            entry.handler.tool_revision.load(Ordering::Relaxed) != entry.seen_tool_revision,
            entry.handler.resource_revision.load(Ordering::Relaxed) != entry.seen_resource_revision,
            entry.handler.prompt_revision.load(Ordering::Relaxed) != entry.seen_prompt_revision,
        )
    };
    if !tool_changed && !resource_changed && !prompt_changed {
        return Ok(());
    }
    let tools = if tool_changed {
        Some(tool_records(
            config.id(),
            list_tools(&peer, config.timeout()).await?,
        )?)
    } else {
        None
    };
    let resources = if resource_changed {
        Some((
            json_values(&list_resources(&peer, config.timeout()).await?)?,
            json_values(&list_templates(&peer, config.timeout()).await?)?,
        ))
    } else {
        None
    };
    let prompts = if prompt_changed {
        Some(json_values(&list_prompts(&peer, config.timeout()).await?)?)
    } else {
        None
    };
    let mut manager = lock(&state);
    let Some(entry) = manager.entries.get_mut(&id) else {
        return Ok(());
    };
    if entry.generation != generation || entry.state != "connected" {
        return Ok(());
    }
    let tools_changed = tools.is_some();
    if let Some((tools, skipped_tasks, skipped_output)) = tools {
        entry.tools = tools;
        entry.skipped_task_tools = skipped_tasks;
        entry.skipped_output_tools = skipped_output;
        entry.seen_tool_revision = entry.handler.tool_revision.load(Ordering::Relaxed);
    }
    if let Some((resources, templates)) = resources {
        entry.resources = resources;
        entry.templates = templates;
        entry.seen_resource_revision = entry.handler.resource_revision.load(Ordering::Relaxed);
    }
    if let Some(prompts) = prompts {
        entry.prompts = prompts;
        entry.seen_prompt_revision = entry.handler.prompt_revision.load(Ordering::Relaxed);
    }
    entry.error = None;
    if tools_changed {
        manager.tool_revision += 1;
    }
    Ok(())
}

fn json_pretty(value: &Value) -> napi::Result<String> {
    serde_json::to_string_pretty(value).map_err(|error| failed(error.to_string()))
}

fn binary(label: &str, mime_type: Option<&str>, data: &str) -> String {
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    let size = data.len().saturating_mul(3) / 4;
    format!(
        "[{label}: {}, {} bytes omitted]",
        mime_type.unwrap_or("unknown type"),
        size.saturating_sub(padding)
    )
}

fn format_resource(value: &Value) -> napi::Result<String> {
    let uri = value
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("MCP resource content is malformed"))?;
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Ok(format!("[resource {uri}]\n{text}"));
    }
    let blob = value
        .get("blob")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("MCP resource content is malformed"))?;
    Ok(format!(
        "[resource {uri}]\n{}",
        binary(
            "binary resource",
            value.get("mimeType").and_then(Value::as_str),
            blob
        )
    ))
}

fn format_content(value: &Value) -> napi::Result<String> {
    match value.get("type").and_then(Value::as_str) {
        Some("text") => value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| failed("MCP text content is malformed")),
        Some("image") => Ok(binary(
            "image",
            value.get("mimeType").and_then(Value::as_str),
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP image content is malformed"))?,
        )),
        Some("audio") => Ok(binary(
            "audio",
            value.get("mimeType").and_then(Value::as_str),
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP audio content is malformed"))?,
        )),
        Some("resource_link") => Ok(format!(
            "[resource {}: {}]",
            value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("resource"),
            value
                .get("uri")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP resource link is malformed"))?
        )),
        Some("resource") => format_resource(
            value
                .get("resource")
                .ok_or_else(|| failed("MCP embedded resource is malformed"))?,
        ),
        _ => Err(failed("MCP content block is malformed")),
    }
}

fn format_tool_result(value: &Value) -> napi::Result<String> {
    if let Some(legacy) = value.get("toolResult") {
        return json_pretty(legacy);
    }
    let mut sections = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| failed("MCP tool result is malformed"))?
        .iter()
        .map(format_content)
        .collect::<napi::Result<Vec<_>>>()?;
    if let Some(structured) = value.get("structuredContent") {
        sections.push(format!("Structured content:\n{}", json_pretty(structured)?));
    }
    sections.retain(|section| !section.is_empty());
    let output = if sections.is_empty() {
        "(empty MCP tool result)".to_owned()
    } else {
        sections.join("\n\n")
    };
    if value.get("isError").and_then(Value::as_bool) == Some(true) {
        return Ok(format!("MCP tool returned an error.\n\n{output}"));
    }
    Ok(output)
}

fn format_prompt(value: &Value) -> napi::Result<String> {
    let mut sections = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| failed("MCP prompt result is malformed"))?
        .iter()
        .map(|message| {
            Ok(format!(
                "{}:\n{}",
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failed("MCP prompt message is malformed"))?,
                format_content(
                    message
                        .get("content")
                        .ok_or_else(|| failed("MCP prompt message is malformed"))?
                )?
            ))
        })
        .collect::<napi::Result<Vec<_>>>()?;
    if let Some(description) = value.get("description").and_then(Value::as_str) {
        sections.insert(0, description.to_owned());
    }
    if sections.is_empty() {
        return Ok("(empty MCP prompt)".to_owned());
    }
    Ok(sections.join("\n\n"))
}

fn progress_text(params: &ProgressNotificationParam) -> String {
    if let Some(message) = &params.message {
        return message.clone();
    }
    let progress = number_text(params.progress);
    params.total.map_or_else(
        || format!("MCP progress {progress}"),
        |total| format!("MCP progress {progress}/{}", number_text(total)),
    )
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    value.to_string()
}

async fn await_tool_response(
    mut handle: rmcp::service::RequestHandle<RoleClient>,
    duration: Duration,
    cancelled: &AtomicBool,
) -> napi::Result<ServerResult> {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            response = &mut handle.rx => {
                return response
                    .map_err(|_| failed("MCP tool connection closed"))?
                    .map_err(|error| failed(error.to_string()));
            }
            () = &mut deadline => {
                let _ = handle.cancel(Some("request timeout".to_owned())).await;
                return Err(failed(format!("MCP tool call timed out after {}ms", duration.as_millis())));
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {
                if cancelled.load(Ordering::Relaxed) {
                    let _ = handle.cancel(Some("request cancelled".to_owned())).await;
                    return Err(failed("MCP tool call was cancelled"));
                }
            }
        }
    }
}

fn output_validation(tool: &str, schema: Option<&Value>, result: &Value) -> napi::Result<()> {
    let Some(schema) = schema else {
        return Ok(());
    };
    if result.get("toolResult").is_some() {
        return Err(failed(format!(
            "MCP tool {tool} has an output schema but returned a legacy tool result"
        )));
    }
    let structured = result.get("structuredContent");
    let is_error = result.get("isError").and_then(Value::as_bool) == Some(true);
    if structured.is_none() && !is_error {
        return Err(failed(format!(
            "MCP tool {tool} has an output schema but returned no structured content"
        )));
    }
    let Some(structured) = structured else {
        return Ok(());
    };
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| failed(error.to_string()))?;
    let errors = validator.iter_errors(structured).collect::<Vec<_>>();
    if errors.is_empty() {
        return Ok(());
    }
    let detail = errors
        .iter()
        .map(|error| format!("{} {error}", error.instance_path()))
        .collect::<Vec<_>>()
        .join("; ");
    Err(failed(format!(
        "MCP tool {tool} returned invalid structured content: {detail}"
    )))
}

#[derive(Deserialize)]
struct ResourceRequest {
    server: String,
    uri: String,
}

#[derive(Deserialize)]
struct PromptRequest {
    server: String,
    name: String,
    arguments: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
struct ToolCallRequest {
    server: String,
    name: String,
    arguments: Map<String, Value>,
}

pub struct ManagerTask {
    state: Arc<Mutex<ManagerState>>,
    runtime: Arc<Runtime>,
    operation: ManagerOperation,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
enum ManagerOperation {
    ConnectAll,
    Reconnect(Option<String>),
    Remove(String),
    Refresh,
    Close,
    ReadResource(String),
    GetPrompt(String),
}

impl Task for ManagerTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let state = self.state.clone();
        let cancelled = self.cancelled.clone();
        let operation = self.operation.clone();
        self.runtime.block_on(async move {
            match &operation {
                ManagerOperation::ConnectAll => {
                    let ids = {
                        let manager = lock(&state);
                        manager
                            .order
                            .iter()
                            .filter(|id| {
                                manager
                                    .entries
                                    .get(*id)
                                    .is_some_and(|entry| entry.config.enabled())
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    };
                    for id in ids {
                        if cancelled.load(Ordering::Relaxed) {
                            break;
                        }
                        connect_entry(state.clone(), id, cancelled.clone()).await?;
                    }
                    if cancelled.load(Ordering::Relaxed) {
                        close_all(state.clone()).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Reconnect(server) => {
                    let ids = if let Some(server) = server {
                        vec![server.clone()]
                    } else {
                        let manager = lock(&state);
                        manager
                            .order
                            .iter()
                            .filter(|id| {
                                manager
                                    .entries
                                    .get(*id)
                                    .is_some_and(|entry| entry.config.enabled())
                            })
                            .cloned()
                            .collect()
                    };
                    for id in ids {
                        connect_entry(state.clone(), id, cancelled.clone()).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Remove(server) => {
                    remove_entry(state.clone(), server).await?;
                    Ok(None)
                }
                ManagerOperation::Refresh => {
                    let ids = lock(&state).order.clone();
                    for id in ids {
                        refresh_entry(state.clone(), id).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Close => {
                    close_all(state.clone()).await?;
                    Ok(None)
                }
                ManagerOperation::ReadResource(request) => {
                    let request: ResourceRequest =
                        serde_json::from_str(request).map_err(|error| {
                            invalid(format!("invalid MCP resource request: {error}"))
                        })?;
                    if request.server.is_empty() {
                        return Err(invalid("server is required"));
                    }
                    if request.uri.is_empty() {
                        return Err(invalid("uri is required"));
                    }
                    let (peer, duration) = connected_peer(&state, &request.server, "resources")?;
                    let result = cancellable(
                        duration,
                        "MCP resource read",
                        &cancelled,
                        peer.read_resource(ReadResourceRequestParams::new(request.uri)),
                    )
                    .await?;
                    let value =
                        serde_json::to_value(result).map_err(|error| failed(error.to_string()))?;
                    let mut sections = value
                        .get("contents")
                        .and_then(Value::as_array)
                        .ok_or_else(|| failed("MCP resource result is malformed"))?
                        .iter()
                        .map(format_resource)
                        .collect::<napi::Result<Vec<_>>>()?;
                    sections.retain(|section| !section.is_empty());
                    Ok(Some(if sections.is_empty() {
                        "(empty MCP resource)".to_owned()
                    } else {
                        sections.join("\n\n")
                    }))
                }
                ManagerOperation::GetPrompt(request) => {
                    let request: PromptRequest = serde_json::from_str(request)
                        .map_err(|error| invalid(format!("invalid MCP prompt request: {error}")))?;
                    if request.server.is_empty() {
                        return Err(invalid("server is required"));
                    }
                    if request.name.is_empty() {
                        return Err(invalid("name is required"));
                    }
                    let (peer, duration) = connected_peer(&state, &request.server, "prompts")?;
                    let result = cancellable(
                        duration,
                        "MCP prompt request",
                        &cancelled,
                        peer.get_prompt({
                            let mut params = rmcp::model::GetPromptRequestParams::new(request.name);
                            params.arguments = request.arguments;
                            params
                        }),
                    )
                    .await?;
                    let value =
                        serde_json::to_value(result).map_err(|error| failed(error.to_string()))?;
                    Ok(Some(format_prompt(&value)?))
                }
            }
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

fn connected_peer(
    state: &Arc<Mutex<ManagerState>>,
    server: &str,
    capability: &str,
) -> napi::Result<(Peer<RoleClient>, Duration)> {
    let manager = lock(state);
    let entry = manager
        .entries
        .get(server)
        .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
    if entry.state != "connected" {
        return Err(failed(format!("MCP server is not connected: {server}")));
    }
    let peer = entry
        .peer
        .clone()
        .ok_or_else(|| failed(format!("MCP server is not connected: {server}")))?;
    if !has_capability(&peer, capability) {
        return Err(failed(format!(
            "MCP server does not provide {capability}: {server}"
        )));
    }
    Ok((peer, entry.config.timeout()))
}

async fn remove_entry(state: Arc<Mutex<ManagerState>>, server: &str) -> napi::Result<()> {
    let service = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let mut entry = manager
            .entries
            .remove(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        manager.order.retain(|id| id != server);
        if !entry.tools.is_empty() {
            manager.tool_revision += 1;
        }
        entry.service.take()
    };
    if let Some(mut service) = service {
        close_service(&mut service).await?;
    }
    Ok(())
}

async fn close_all(state: Arc<Mutex<ManagerState>>) -> napi::Result<()> {
    let services = {
        let mut manager = lock(&state);
        manager.closing = true;
        let mut services = Vec::new();
        let mut changed = false;
        for entry in manager.entries.values_mut() {
            changed |= !entry.tools.is_empty();
            if let Some(service) = entry.service.take() {
                services.push((entry.config.id().to_owned(), service));
            }
            entry.peer = None;
            entry.connection_transport = None;
            entry.state = if entry.config.enabled() {
                "idle".to_owned()
            } else {
                "disabled".to_owned()
            };
            entry.tools.clear();
            entry.resources.clear();
            entry.templates.clear();
            entry.prompts.clear();
            entry.instructions = None;
        }
        if changed {
            manager.tool_revision += 1;
        }
        services
    };
    let mut failures = Vec::new();
    for (id, mut service) in services {
        if let Err(error) = close_service(&mut service).await {
            failures.push(format!("{id}: {error}"));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(failed(failures.join("; ")))
}

struct ProgressReceiver {
    receiver: mpsc::Receiver<ProgressEvent>,
    pending: VecDeque<ProgressEvent>,
}

struct CallShared {
    progress: Mutex<ProgressReceiver>,
    result: Mutex<Option<mpsc::Receiver<Result<String, String>>>>,
    cancelled: AtomicBool,
}

#[napi]
pub struct NativeMcpCall {
    shared: Arc<CallShared>,
}

pub struct ProgressTask {
    shared: Arc<CallShared>,
    cancelled: Arc<AtomicBool>,
}

impl Task for ProgressTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(failed("MCP progress wait was cancelled"));
            }
            let mut progress = lock(&self.shared.progress);
            if let Some(event) = progress.pending.pop_front() {
                return Ok(Some(event.text));
            }
            let first = match progress.receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            };
            let mut batch = vec![first];
            while let Ok(event) = progress.receiver.recv_timeout(Duration::from_millis(2)) {
                batch.push(event);
            }
            batch.sort_by(|left, right| left.progress.total_cmp(&right.progress));
            progress.pending.extend(batch);
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CallResultTask {
    shared: Arc<CallShared>,
    cancelled: Arc<AtomicBool>,
}

impl Task for CallResultTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let receiver = lock(&self.shared.result)
            .take()
            .ok_or_else(|| failed("MCP tool result was already collected"))?;
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                self.shared.cancelled.store(true, Ordering::Relaxed);
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(output)) => return Ok(output),
                Ok(Err(error)) => return Err(failed(error)),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failed("MCP tool call ended without a result"));
                }
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl NativeMcpCall {
    #[napi(catch_unwind)]
    pub fn next_progress(&self, signal: Option<AbortSignal>) -> AsyncTask<ProgressTask> {
        AsyncTask::new(ProgressTask {
            shared: self.shared.clone(),
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn result(&self, signal: Option<AbortSignal>) -> AsyncTask<CallResultTask> {
        AsyncTask::new(CallResultTask {
            shared: self.shared.clone(),
            cancelled: cancellation_flag(signal),
        })
    }
}

fn tool_descriptors(manager: &ManagerState) -> Value {
    let tools = manager
        .order
        .iter()
        .filter_map(|id| manager.entries.get(id))
        .filter(|entry| entry.state == "connected")
        .flat_map(|entry| {
            entry.tools.iter().map(|tool| {
                let title = tool
                    .remote
                    .title
                    .clone()
                    .or_else(|| {
                        tool.remote
                            .annotations
                            .as_ref()
                            .and_then(|value| value.title.clone())
                    })
                    .unwrap_or_else(|| format!("{}: {}", entry.config.id(), tool.remote.name));
                json!({
                    "name": tool.native_name,
                    "server": entry.config.id(),
                    "remoteName": tool.remote.name,
                    "description": format!(
                        "MCP tool {} from server {}. {}",
                        tool.remote.name,
                        entry.config.id(),
                        tool.remote.description.as_deref().unwrap_or("No server description.")
                    ),
                    "parameters": Value::Object((*tool.remote.input_schema).clone()),
                    "title": title
                })
            })
        })
        .collect::<Vec<_>>();
    json!({ "revision": manager.tool_revision, "tools": tools })
}

fn server_status(entry: &Entry) -> Value {
    let mut warnings = Vec::new();
    if !entry.skipped_task_tools.is_empty() {
        warnings.push(format!(
            "{} task-based tools skipped",
            entry.skipped_task_tools.len()
        ));
    }
    if !entry.skipped_output_tools.is_empty() {
        warnings.push(format!(
            "output schemas skipped: {}",
            entry.skipped_output_tools.join("; ")
        ));
    }
    if let Some(error) = &entry.error {
        warnings.push(error.clone());
    }
    let mut status = json!({
        "id": entry.config.id(),
        "configuredTransport": entry.config.transport(),
        "state": entry.state,
        "tools": entry.tools.len(),
        "resources": entry.resources.len(),
        "resourceTemplates": entry.templates.len(),
        "prompts": entry.prompts.len()
    });
    let object = status.as_object_mut().expect("status is an object");
    if let Some(transport) = &entry.connection_transport {
        object.insert(
            "connectionTransport".to_owned(),
            Value::String(transport.clone()),
        );
    }
    if !warnings.is_empty() {
        object.insert("warning".to_owned(), Value::String(warnings.join("; ")));
    }
    status
}

#[napi]
impl NativeMcpManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(configs: String, app_name: String, app_version: String) -> napi::Result<Self> {
        let configs: Vec<ServerConfig> = serde_json::from_str(&configs)
            .map_err(|error| invalid(format!("invalid native MCP configuration: {error}")))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| failed(error.to_string()))?;
        let mut entries = HashMap::new();
        let mut order = Vec::new();
        for config in configs {
            let id = config.id().to_owned();
            if entries.contains_key(&id) {
                return Err(invalid(format!("duplicate MCP server: {id}")));
            }
            order.push(id.clone());
            entries.insert(
                id,
                Entry {
                    state: if config.enabled() { "idle" } else { "disabled" }.to_owned(),
                    config,
                    connection_transport: None,
                    service: None,
                    peer: None,
                    handler: Arc::new(HandlerState::default()),
                    tools: Vec::new(),
                    resources: Vec::new(),
                    templates: Vec::new(),
                    prompts: Vec::new(),
                    instructions: None,
                    error: None,
                    skipped_task_tools: Vec::new(),
                    skipped_output_tools: Vec::new(),
                    seen_tool_revision: 0,
                    seen_resource_revision: 0,
                    seen_prompt_revision: 0,
                    generation: 0,
                },
            );
        }
        Ok(Self {
            state: Arc::new(Mutex::new(ManagerState {
                entries,
                order,
                closing: false,
                tool_revision: 0,
                app_name,
                app_version,
            })),
            runtime: Arc::new(runtime),
        })
    }

    fn task(
        &self,
        operation: ManagerOperation,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        AsyncTask::new(ManagerTask {
            state: self.state.clone(),
            runtime: self.runtime.clone(),
            operation,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn connect_all(&self, signal: Option<AbortSignal>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ConnectAll, signal)
    }

    #[napi(catch_unwind)]
    pub fn reconnect(&self, server: Option<String>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Reconnect(server), None)
    }

    #[napi(catch_unwind)]
    pub fn remove(&self, server: String) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Remove(server), None)
    }

    #[napi(catch_unwind)]
    pub fn refresh(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Refresh, None)
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Close, None)
    }

    #[napi(catch_unwind)]
    pub fn servers(&self) -> napi::Result<String> {
        let manager = lock(&self.state);
        serde_json::to_string(
            &manager
                .order
                .iter()
                .filter_map(|id| manager.entries.get(id))
                .map(server_status)
                .collect::<Vec<_>>(),
        )
        .map_err(|error| failed(error.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, server: Option<String>) -> Vec<String> {
        let manager = lock(&self.state);
        let statuses = manager
            .order
            .iter()
            .filter(|id| server.as_ref().is_none_or(|server| *id == server))
            .filter_map(|id| manager.entries.get(id))
            .map(server_status)
            .collect::<Vec<_>>();
        if statuses.is_empty() {
            return vec!["No MCP servers configured.".to_owned()];
        }
        statuses
            .iter()
            .map(|status| {
                let id = status["id"].as_str().unwrap_or("MCP");
                let state = status["state"].as_str().unwrap_or("failed");
                let warning = status.get("warning").and_then(Value::as_str);
                if state == "connected" {
                    return format!(
                        "{id} · connected ({}) · {} tools · {} resources · {} templates · {} prompts{}",
                        status["connectionTransport"].as_str().unwrap_or("unknown"),
                        status["tools"].as_u64().unwrap_or(0),
                        status["resources"].as_u64().unwrap_or(0),
                        status["resourceTemplates"].as_u64().unwrap_or(0),
                        status["prompts"].as_u64().unwrap_or(0),
                        warning.map(|warning| format!(" · warning: {warning}")).unwrap_or_default()
                    );
                }
                if state == "failed" {
                    return format!("{id} · failed · {}", warning.unwrap_or("unknown error"));
                }
                format!("{id} · {state}")
            })
            .collect()
    }

    #[napi(getter, catch_unwind)]
    pub fn has_resources(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "resources"))
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn has_prompts(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "prompts"))
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn prompt(&self) -> String {
        let manager = lock(&self.state);
        manager
            .order
            .iter()
            .filter_map(|id| manager.entries.get(id))
            .filter(|entry| entry.state == "connected")
            .filter_map(|entry| {
                entry.instructions.as_ref().map(|instructions| {
                    format!(
                        "MCP server {} instructions:\n{instructions}",
                        entry.config.id()
                    )
                })
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    #[napi(catch_unwind)]
    pub fn resource_catalog(&self, server: Option<String>) -> napi::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server.as_deref(), "resources")?
            .into_iter()
            .map(|entry| {
                json!({
                    "server": entry.config.id(),
                    "resources": entry.resources,
                    "templates": entry.templates
                })
            })
            .collect::<Vec<_>>();
        json_pretty(&Value::Array(values))
    }

    #[napi(catch_unwind)]
    pub fn prompt_catalog(&self, server: Option<String>) -> napi::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server.as_deref(), "prompts")?
            .into_iter()
            .map(|entry| json!({ "server": entry.config.id(), "prompts": entry.prompts }))
            .collect::<Vec<_>>();
        json_pretty(&Value::Array(values))
    }

    #[napi(catch_unwind)]
    pub fn read_resource(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ReadResource(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn get_prompt(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::GetPrompt(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn tool_descriptors(&self) -> napi::Result<String> {
        serde_json::to_string(&tool_descriptors(&lock(&self.state)))
            .map_err(|error| failed(error.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn start_tool_call(&self, request: String) -> napi::Result<NativeMcpCall> {
        let request: ToolCallRequest = serde_json::from_str(&request)
            .map_err(|error| invalid(format!("invalid MCP tool request: {error}")))?;
        if request.server.is_empty() {
            return Err(invalid("server is required"));
        }
        if request.name.is_empty() {
            return Err(invalid("name is required"));
        }
        let (peer, handler, duration, schema) = {
            let manager = lock(&self.state);
            let entry = manager
                .entries
                .get(&request.server)
                .ok_or_else(|| failed(format!("unknown MCP server: {}", request.server)))?;
            if entry.state != "connected" {
                return Err(failed(format!(
                    "MCP server is not connected: {}",
                    request.server
                )));
            }
            let tool = entry
                .tools
                .iter()
                .find(|tool| tool.remote.name == request.name)
                .ok_or_else(|| {
                    failed(format!(
                        "MCP tool is no longer available: {}/{}",
                        request.server, request.name
                    ))
                })?;
            (
                entry
                    .peer
                    .clone()
                    .ok_or_else(|| failed("MCP server disconnected"))?,
                entry.handler.clone(),
                entry.config.timeout(),
                tool.output_schema.clone(),
            )
        };
        let (progress_sender, progress_receiver) = mpsc::sync_channel(PROGRESS_CAPACITY);
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let shared = Arc::new(CallShared {
            progress: Mutex::new(ProgressReceiver {
                receiver: progress_receiver,
                pending: VecDeque::new(),
            }),
            result: Mutex::new(Some(result_receiver)),
            cancelled: AtomicBool::new(false),
        });
        let task_shared = shared.clone();
        let remote_name = request.name.clone();
        self.runtime.spawn(async move {
            let mut params = CallToolRequestParams::new(Cow::Owned(request.name));
            params.arguments = Some(request.arguments);
            let handle = peer
                .send_cancellable_request(
                    ClientRequest::CallToolRequest(CallToolRequest::new(params)),
                    PeerRequestOptions::no_options(),
                )
                .await;
            let progress_key = handle
                .as_ref()
                .ok()
                .and_then(|handle| serde_json::to_string(&handle.progress_token).ok());
            if let Some(progress_key) = &progress_key {
                lock(&handler.progress).insert(progress_key.clone(), progress_sender);
            }
            let outcome = match handle {
                Ok(handle) => await_tool_response(handle, duration, &task_shared.cancelled)
                    .await
                    .and_then(|result| match result {
                        ServerResult::CallToolResult(result) => Ok(result),
                        _ => Err(failed("MCP tool returned an unexpected response")),
                    })
                    .and_then(|result| {
                        let value = serde_json::to_value(result)
                            .map_err(|error| failed(error.to_string()))?;
                        output_validation(&remote_name, schema.as_ref(), &value)?;
                        format_tool_result(&value)
                    }),
                Err(error) => Err(failed(error.to_string())),
            }
            .map_err(|error| error.to_string());
            if let Some(progress_key) = progress_key {
                lock(&handler.progress).remove(&progress_key);
            }
            let _ = result_sender.send(outcome);
        });
        Ok(NativeMcpCall { shared })
    }
}

fn connected_entries<'a>(
    manager: &'a ManagerState,
    server: Option<&str>,
    capability: &str,
) -> napi::Result<Vec<&'a Entry>> {
    if let Some(server) = server {
        let entry = manager
            .entries
            .get(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        if entry.state != "connected" {
            return Err(failed(format!("MCP server is not connected: {server}")));
        }
        let peer = entry
            .peer
            .as_ref()
            .ok_or_else(|| failed(format!("MCP server is not connected: {server}")))?;
        if !has_capability(peer, capability) {
            return Err(failed(format!(
                "MCP server does not provide {capability}: {server}"
            )));
        }
        return Ok(vec![entry]);
    }
    Ok(manager
        .order
        .iter()
        .filter_map(|id| manager.entries.get(id))
        .filter(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, capability))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{native_tool_name, progress_text};
    use rmcp::model::{NumberOrString, ProgressNotificationParam, ProgressToken};

    #[test]
    fn normalizes_tool_names_stably() {
        assert_eq!(native_tool_name("server", "read"), "mcp__server__read");
        assert!(native_tool_name("server", "read tool").starts_with("mcp__server__read_tool_"));
        assert!(
            native_tool_name("server", &"x".repeat(100))
                .encode_utf16()
                .count()
                <= 64
        );
    }

    #[test]
    fn formats_progress() {
        let progress = ProgressNotificationParam::new(
            ProgressToken(NumberOrString::String("call".into())),
            2.0,
        )
        .with_total(4.0);
        assert_eq!(progress_text(&progress), "MCP progress 2/4");
    }
}
