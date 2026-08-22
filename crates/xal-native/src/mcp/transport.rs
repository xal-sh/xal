use super::*;

pub(super) async fn timeout<T>(
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

pub(super) async fn cancellable<T>(
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
    reader_error: Arc<Mutex<Option<String>>>,
}

impl LegacySseTransport {
    async fn connect(
        client: reqwest13::Client,
        url: &str,
        headers: reqwest13::header::HeaderMap,
    ) -> napi::Result<Self> {
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
        let reader_error = Arc::new(Mutex::new(None));
        let task_error = reader_error.clone();
        let reader = tokio::spawn(async move {
            let result = async {
                process_sse_buffer(&mut buffer, &sender).await?;
                while let Some(chunk) = stream.next().await {
                    let chunk =
                        chunk.map_err(|error| failed(format!("legacy MCP SSE failed: {error}")))?;
                    extend_sse_buffer(&mut buffer, &chunk)?;
                    process_sse_buffer(&mut buffer, &sender).await?;
                }
                Err::<(), _>(failed("legacy MCP SSE connection closed"))
            }
            .await;
            if let Err(error) = result {
                *lock(&task_error) = Some(error.to_string());
            }
        });
        Ok(Self {
            client,
            endpoint,
            headers,
            receiver,
            reader,
            reader_error,
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
        std::future::ready(match lock(&self.reader_error).take() {
            Some(error) => Err(std::io::Error::other(error)),
            None => Ok(()),
        })
    }
}

pub(super) fn with_stderr(error: Error, stderr: Option<&StderrTail>) -> Error {
    let Some(stderr) = stderr.and_then(stderr_text) else {
        return error;
    };
    failed(format!("{error}; MCP server stderr: {stderr}"))
}

pub(super) async fn connect_service(
    config: &ServerConfig,
    handler: Handler,
    cancelled: &AtomicBool,
) -> napi::Result<(
    RunningService<RoleClient, Handler>,
    String,
    Option<StderrTail>,
)> {
    match config {
        ServerConfig::Stdio {
            command,
            args,
            env,
            cwd,
            ..
        } => {
            let mut process = tokio::process::Command::new(command);
            process.args(args).envs(env);
            if let Some(cwd) = cwd {
                process.current_dir(cwd);
            }
            let (transport, stderr) = StdioTransport::spawn(process)
                .map_err(|error| failed(format!("failed to launch MCP server: {error}")))?;
            let service = cancellable(
                config.timeout(),
                "MCP connection",
                cancelled,
                handler.serve(transport),
            )
            .await
            .map_err(|error| with_stderr(error, Some(&stderr)))?;
            Ok((service, "stdio".to_owned(), Some(stderr)))
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
                .redirect(reqwest13::redirect::Policy::none())
                .connect_timeout(config.timeout().min(Duration::from_secs(10)))
                .build()
                .map_err(|error| failed(error.to_string()))?;
            let mut retry = rmcp::transport::common::client_side_sse::FixedInterval::default();
            retry.max_times = Some(5);
            let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                .custom_headers(
                    parsed_headers
                        .iter()
                        .map(|(name, value)| (name.clone(), value.clone()))
                        .collect(),
                );
            transport_config.retry_config = Arc::new(retry);
            let http_client = HttpClient::new(client.clone(), config.timeout());
            let transport =
                StreamableHttpClientTransport::with_client(http_client.clone(), transport_config);
            let http = cancellable(
                config.timeout(),
                "MCP connection",
                cancelled,
                handler.clone().serve(transport),
            )
            .await;
            match http {
                Ok(service) => Ok((service, "http".to_owned(), None)),
                Err(http_error) => {
                    let http_reason = http_error.to_string();
                    if !http_client.allows_legacy_fallback() {
                        return Err(failed(format!("streamable HTTP failed: {http_reason}")));
                    }
                    let transport = cancellable(
                        config.timeout(),
                        "legacy MCP connection",
                        cancelled,
                        LegacySseTransport::connect(client, url, parsed_headers),
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
                    Ok((service, "sse".to_owned(), None))
                }
            }
        }
    }
}
pub(super) async fn close_service(
    service: &mut RunningService<RoleClient, Handler>,
) -> napi::Result<()> {
    match service.close_with_timeout(Duration::from_secs(5)).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(failed("MCP connection close timed out after 5000ms")),
        Err(error) => Err(failed(format!("MCP connection close: {error}"))),
    }
}
