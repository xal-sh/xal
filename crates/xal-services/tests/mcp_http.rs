use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use xal_services::mcp::*;

#[derive(Clone, Copy)]
enum Mode {
    Json,
    Stream,
    Legacy,
    Failure(u16),
    CrossOrigin,
    Malformed,
    Oversized,
    DeleteFailure,
}

struct Network {
    url: String,
    state: Arc<State>,
    task: JoinHandle<()>,
}

struct State {
    events: broadcast::Sender<String>,
    gets: AtomicUsize,
    deletes: AtomicUsize,
    cancels: AtomicUsize,
    authorized: AtomicUsize,
    active_streams: AtomicUsize,
    discovery: AtomicUsize,
    initializes: AtomicUsize,
    pause_initialize: AtomicBool,
    pause_endpoint: AtomicBool,
    pause_discovery: AtomicBool,
}

impl Network {
    async fn new(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let state = Arc::new(State {
            events: broadcast::channel(32).0,
            gets: AtomicUsize::new(0),
            deletes: AtomicUsize::new(0),
            cancels: AtomicUsize::new(0),
            authorized: AtomicUsize::new(0),
            active_streams: AtomicUsize::new(0),
            discovery: AtomicUsize::new(0),
            initializes: AtomicUsize::new(0),
            pause_initialize: AtomicBool::new(false),
            pause_endpoint: AtomicBool::new(false),
            pause_discovery: AtomicBool::new(false),
        });
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    socket = listener.accept() => {
                        let (socket, _) = socket.unwrap();
                        tasks.spawn(serve(socket, mode, shared.clone()));
                    }
                    Some(result) = tasks.join_next() => { result.unwrap().unwrap(); }
                }
            }
        });
        Self { url, state, task }
    }

    fn manager(&self) -> McpManager {
        McpManager::new(
            vec![ServerConfig::Http {
                id: "network".into(),
                enabled: true,
                timeout_ms: 1000,
                url: self.url.clone(),
                headers: HashMap::from([("Authorization".into(), "Bearer fixture".into())]),
            }],
            "test".into(),
            "1".into(),
        )
        .unwrap()
    }

    async fn close(self) {
        self.task.abort();
        match (&mut { self.task }).await {
            Err(error) if error.is_cancelled() => {}
            result => panic!("network fixture stopped unexpectedly: {result:?}"),
        }
    }
}

async fn respond(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
    session: bool,
) -> io::Result<()> {
    socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{body}", body.len(), if session { "Mcp-Session-Id: fixture-session\r\n" } else { "" }).as_bytes()).await
}

async fn serve(mut socket: TcpStream, mode: Mode, state: Arc<State>) -> io::Result<()> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let end = loop {
        let count = socket.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        assert!(bytes.len() < 64 * 1024);
    };
    let headers = String::from_utf8(bytes[..end].to_vec())
        .unwrap()
        .to_ascii_lowercase();
    if headers.contains("authorization: bearer fixture") {
        state.authorized.fetch_add(1, Ordering::Relaxed);
    }
    if headers.starts_with("delete ") {
        assert!(headers.contains("mcp-session-id: fixture-session"));
        state.deletes.fetch_add(1, Ordering::Relaxed);
        return respond(
            &mut socket,
            if matches!(mode, Mode::DeleteFailure) {
                500
            } else {
                200
            },
            "text/plain",
            "",
            false,
        )
        .await;
    }
    if headers.starts_with("get ") {
        state.gets.fetch_add(1, Ordering::Relaxed);
        if !matches!(mode, Mode::Legacy | Mode::CrossOrigin) {
            return respond(&mut socket, 405, "text/plain", "no stream", false).await;
        }
        let mut events = state.events.subscribe();
        let endpoint = if matches!(mode, Mode::CrossOrigin) {
            "http://127.0.0.1:1/stolen"
        } else {
            "/messages"
        };
        let event = if state.pause_endpoint.load(Ordering::Relaxed) {
            ": waiting\n\n".into()
        } else {
            format!("event: endpoint\ndata: {endpoint}\n\n")
        };
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{event}").as_bytes()).await?;
        state.active_streams.fetch_add(1, Ordering::Relaxed);
        loop {
            tokio::select! {
                received = socket.read(&mut buffer) => { received?; break; }
                event = events.recv() => {
                    let event = event.map_err(io::Error::other)?;
                    socket.write_all(format!("event: message\ndata: {event}\n\n").as_bytes()).await?;
                }
            }
        }
        state.active_streams.fetch_sub(1, Ordering::Relaxed);
        return Ok(());
    }
    let length = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap()
        .parse::<usize>()
        .unwrap();
    while bytes.len() < end + length {
        let count = socket.read(&mut buffer).await?;
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
    if matches!(mode, Mode::Legacy | Mode::CrossOrigin) && headers.starts_with("post /mcp ") {
        return respond(&mut socket, 405, "text/plain", "use SSE", false).await;
    }
    if let Mode::Failure(status) = mode {
        return respond(&mut socket, status, "text/plain", "fixture failure", false).await;
    }
    if matches!(mode, Mode::Malformed) {
        return respond(&mut socket, 200, "application/json", "not json", false).await;
    }
    if matches!(mode, Mode::Oversized) {
        return socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16777217\r\nConnection: close\r\n\r\n").await;
    }
    if request["method"] == "initialize" {
        state.initializes.fetch_add(1, Ordering::Relaxed);
        if state.pause_initialize.load(Ordering::Relaxed) {
            if matches!(mode, Mode::Legacy) {
                return respond(&mut socket, 202, "text/plain", "", false).await;
            }
            assert_eq!(socket.read(&mut buffer).await?, 0);
            return Ok(());
        }
    }
    if request["method"] == "notifications/cancelled" {
        state.cancels.fetch_add(1, Ordering::Relaxed);
    }
    let Some(id) = request.get("id") else {
        return respond(&mut socket, 202, "text/plain", "", false).await;
    };
    if request["method"] == "tools/call" && request["params"]["name"] == "slow" {
        return respond(&mut socket, 202, "text/plain", "", false).await;
    }
    if request["method"] == "tools/list" {
        state.discovery.fetch_add(1, Ordering::Relaxed);
        if state.pause_discovery.load(Ordering::Relaxed) {
            return respond(&mut socket, 202, "text/plain", "", false).await;
        }
    }
    let result = match request["method"].as_str().unwrap() {
        "initialize" => {
            json!({"protocolVersion":request["params"]["protocolVersion"],"serverInfo":{"name":"http-fixture","version":"1"},"capabilities":{"tools":{}},"instructions":"Network instructions"})
        }
        "tools/list" => {
            json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"slow","inputSchema":{"type":"object"}}]})
        }
        "tools/call" => json!({"content":[{"type":"text","text":"network echo"}]}),
        method => panic!("unexpected network method: {method}"),
    };
    let response = json!({"jsonrpc":"2.0","id":id,"result":result}).to_string();
    if matches!(mode, Mode::Legacy) {
        state.events.send(response).unwrap();
        return respond(&mut socket, 202, "text/plain", "", false).await;
    }
    if matches!(mode, Mode::Stream) {
        return respond(
            &mut socket,
            200,
            "text/event-stream",
            &format!("event: message\ndata: {response}\n\n"),
            true,
        )
        .await;
    }
    respond(&mut socket, 200, "application/json", &response, true).await
}

fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[tokio::test]
async fn all_http_transports_cancel_requests_and_release_sessions() {
    for (mode, transport) in [
        (Mode::Json, ConnectionTransport::Http),
        (Mode::Stream, ConnectionTransport::Http),
        (Mode::Legacy, ConnectionTransport::Sse),
    ] {
        let network = Network::new(mode).await;
        let manager = network.manager();
        manager.connect_all(flag()).await.unwrap();
        let statuses = manager.servers();
        assert_eq!(
            statuses[0].state,
            ConnectionState::Connected,
            "{statuses:?}"
        );
        assert_eq!(statuses[0].connection_transport, Some(transport));
        let call = manager
            .start_tool_call(ToolCallRequest {
                server: "network".into(),
                name: "echo".into(),
                arguments: Default::default(),
            })
            .unwrap();
        assert_eq!(
            call.result(&AtomicBool::new(false)).await.unwrap(),
            "network echo"
        );
        let call = manager
            .start_tool_call(ToolCallRequest {
                server: "network".into(),
                name: "slow".into(),
                arguments: Default::default(),
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        call.cancel();
        assert_eq!(
            call.result(&AtomicBool::new(false))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::Interrupted
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while network.state.cancels.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        manager.close().await.unwrap();
        if transport == ConnectionTransport::Http {
            assert_eq!(network.state.deletes.load(Ordering::Relaxed), 1);
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while network.state.active_streams.load(Ordering::Relaxed) != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(network.state.authorized.load(Ordering::Relaxed) >= 4);
        network.close().await;
    }
}

#[tokio::test]
async fn fallback_only_after_initial_4xx_and_rejects_cross_origin_and_unbounded_bodies() {
    for (mode, fallback, message) in [
        (Mode::Failure(500), false, "500"),
        (Mode::Failure(302), false, "302"),
        (Mode::Failure(404), true, "SSE fallback failed"),
        (Mode::CrossOrigin, true, "same origin"),
        (Mode::Malformed, false, "invalid MCP HTTP JSON"),
        (Mode::Oversized, false, "exceeds 16777216"),
    ] {
        let network = Network::new(mode).await;
        let manager = network.manager();
        manager.connect_all(flag()).await.unwrap();
        let status = &manager.servers()[0];
        assert_eq!(status.state, ConnectionState::Failed, "{status:?}");
        assert!(
            status.warning.as_ref().unwrap().contains(message),
            "{status:?}"
        );
        assert_eq!(network.state.gets.load(Ordering::Relaxed) > 0, fallback);
        manager.close().await.unwrap();
        network.close().await;
    }
}

#[tokio::test]
async fn failed_session_cleanup_is_reported() {
    let network = Network::new(Mode::DeleteFailure).await;
    let manager = network.manager();
    manager.connect_all(flag()).await.unwrap();
    assert_eq!(manager.servers()[0].state, ConnectionState::Connected);
    assert!(
        manager
            .close()
            .await
            .unwrap_err()
            .to_string()
            .contains("session deletion rejected HTTP 500")
    );
    network.close().await;
}

#[tokio::test]
async fn cancelled_discovery_preserves_delete_failure_and_allows_fresh_retry() {
    let network = Network::new(Mode::DeleteFailure).await;
    network.state.pause_discovery.store(true, Ordering::Relaxed);
    let manager = network.manager();
    let cancelled = flag();
    let cancel = async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while network.state.discovery.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        cancelled.store(true, Ordering::Relaxed);
    };
    let (result, ()) = tokio::join!(
        manager.reconnect(Some("network"), cancelled.clone()),
        cancel
    );
    let error = result.unwrap_err();
    let deletes = network.state.deletes.load(Ordering::Relaxed);
    network
        .state
        .pause_discovery
        .store(false, Ordering::Relaxed);
    let retry = manager.reconnect(Some("network"), flag()).await;
    let retried = manager.servers()[0].state;
    let close = manager.close().await;
    network.close().await;
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert!(
        error
            .to_string()
            .contains("session deletion rejected HTTP 500"),
        "{error}"
    );
    assert_eq!(deletes, 1);
    retry.unwrap();
    assert_eq!(retried, ConnectionState::Connected);
    assert!(
        close
            .unwrap_err()
            .to_string()
            .contains("session deletion rejected HTTP 500")
    );
}

#[tokio::test]
async fn cancelled_http_setup_preserves_interruption_and_allows_fresh_retry() {
    for (mode, endpoint) in [
        (Mode::Json, false),
        (Mode::Legacy, true),
        (Mode::Legacy, false),
    ] {
        let network = Network::new(mode).await;
        network
            .state
            .pause_initialize
            .store(true, Ordering::Relaxed);
        network
            .state
            .pause_endpoint
            .store(endpoint, Ordering::Relaxed);
        let manager = network.manager();
        let cancelled = flag();
        let cancel = async {
            tokio::time::timeout(Duration::from_secs(2), async {
                while if endpoint {
                    network.state.active_streams.load(Ordering::Relaxed) == 0
                } else {
                    network.state.initializes.load(Ordering::Relaxed) == 0
                } {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            cancelled.store(true, Ordering::Relaxed);
        };
        let (result, ()) = tokio::join!(manager.connect_all(cancelled.clone()), cancel);
        let error = result.unwrap_err();
        let state = manager.servers()[0].state;
        tokio::time::timeout(Duration::from_secs(2), async {
            while network.state.active_streams.load(Ordering::Relaxed) != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        network
            .state
            .pause_initialize
            .store(false, Ordering::Relaxed);
        network.state.pause_endpoint.store(false, Ordering::Relaxed);
        let retry = manager.reconnect(Some("network"), flag()).await;
        let retried = manager.servers()[0].state;
        manager.close().await.unwrap();
        network.close().await;
        assert_eq!(error.kind(), io::ErrorKind::Interrupted, "{error}");
        assert_eq!(state, ConnectionState::Idle);
        retry.unwrap();
        assert_eq!(retried, ConnectionState::Connected);
    }
}
