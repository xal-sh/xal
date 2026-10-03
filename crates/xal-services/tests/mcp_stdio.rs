mod mcp_fixture;

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use mcp_fixture::{Fixture, cancel_soon, flag};
use serde_json::json;
use xal_services::mcp::*;

fn request(name: &str, arguments: serde_json::Value) -> ToolCallRequest {
    ToolCallRequest {
        server: "good".into(),
        name: name.into(),
        arguments: arguments.as_object().unwrap().clone(),
    }
}

#[tokio::test]
async fn stdio_catalogs_validation_progress_changes_and_cleanup() {
    let fixture = Fixture::new();
    let manager = McpManager::new(
        vec![
            fixture.config("good", "", 2000),
            fixture.config("broken", "cursor", 2000),
        ],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    manager.connect_all(flag()).await.unwrap();
    let statuses = manager.servers();
    assert_eq!(
        statuses[0].state,
        ConnectionState::Connected,
        "{statuses:?}"
    );
    assert_eq!(statuses[1].state, ConnectionState::Failed);
    assert!(
        statuses[1]
            .warning
            .as_ref()
            .unwrap()
            .contains("repeated a cursor")
    );
    assert_eq!(
        (
            statuses[0].tools,
            statuses[0].resources,
            statuses[0].resource_templates,
            statuses[0].prompts
        ),
        (3, 2, 1, 1)
    );
    assert!(
        statuses[0]
            .warning
            .as_ref()
            .unwrap()
            .contains("unsupported output schema dialect")
    );
    #[cfg(unix)]
    fixture.assert_stopped("broken").await;
    assert!(manager.has_resources() && manager.has_prompts());
    assert_eq!(manager.instructions("good"), "Use fixture tools.");
    assert!(
        manager
            .resource_catalog(Some("good"))
            .unwrap()
            .contains("fixture://two")
    );
    assert!(manager.prompt_catalog(None).unwrap().contains("hello"));
    let never = AtomicBool::new(false);
    let resource = manager
        .read_resource(
            ResourceRequest {
                server: "good".into(),
                uri: "fixture://one".into(),
            },
            &never,
        )
        .await
        .unwrap();
    assert!(resource.contains("resource text") && resource.contains("2 bytes omitted"));
    let prompt = manager
        .get_prompt(
            PromptRequest {
                server: "good".into(),
                name: "hello".into(),
                arguments: None,
            },
            &never,
        )
        .await
        .unwrap();
    assert!(prompt.contains("user:\nHello Ada"));
    assert!(
        manager
            .start_tool_call(request("echo tool", json!({"value":2})))
            .is_err()
    );
    let task = manager
        .start_tool_call(request("task only", json!({})))
        .unwrap();
    assert!(
        task.result(&never)
            .await
            .unwrap_err()
            .to_string()
            .contains("Tasks support required")
    );
    let invalid = manager
        .start_tool_call(request("echo tool", json!({"value":"invalid"})))
        .unwrap();
    assert!(
        invalid
            .result(&never)
            .await
            .unwrap_err()
            .to_string()
            .contains("invalid structured content")
    );
    let call = manager
        .start_tool_call(request("echo tool", json!({"value":"hello"})))
        .unwrap();
    let collect = async {
        let mut progress = Vec::new();
        while let Some(value) = call.next_progress(&never).await.unwrap() {
            progress.push(value);
        }
        progress
    };
    let (output, progress) = tokio::join!(call.result(&never), collect);
    let output = output.unwrap();
    assert!(
        output.contains("hello")
            && output.contains("[image: image/png, 2 bytes omitted]")
            && output.contains("[audio: audio/wav, 2 bytes omitted]")
    );
    assert_eq!(
        progress,
        [
            "MCP progress 1/4",
            "MCP progress 2/4",
            "MCP progress 3/4",
            "MCP progress 4/4"
        ]
    );
    let revision = manager.tool_descriptors().revision;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            manager.refresh(flag()).await.unwrap();
            if manager.tool_descriptors().revision != revision {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(manager.tool_descriptors().tools[0].remote_name, "added");
    assert!(
        manager
            .start_tool_call(request("echo tool", json!({"value":"hello"})))
            .is_err()
    );
    manager.reconnect(Some("good"), flag()).await.unwrap();
    assert_eq!(manager.tool_descriptors().tools.len(), 3);
    manager.remove("good").await.unwrap();
    assert!(manager.tool_descriptors().tools.is_empty());
    #[cfg(unix)]
    fixture.assert_stopped("good").await;
    manager.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_bootstrap_survivors_and_cancelled_connection_cleanup() {
    let fixture = Fixture::new();
    let manager = McpManager::new(
        vec![
            fixture.config("good", "", 1500),
            fixture.config("slow", "hang", 350),
            fixture.config("second", "hang", 350),
        ],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    let started = Instant::now();
    manager.connect_all(flag()).await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(650));
    assert_eq!(manager.servers()[0].state, ConnectionState::Connected);
    assert!(
        manager.servers()[1]
            .warning
            .as_ref()
            .unwrap()
            .contains("fixture waiting")
    );
    #[cfg(unix)]
    {
        fixture.assert_stopped("slow").await;
        fixture.assert_stopped("second").await;
    }
    manager.close().await.unwrap();
    let manager = McpManager::new(
        vec![fixture.config("cancelled", "hang", 30000)],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    let cancel = flag();
    let (result, ()) = tokio::join!(manager.connect_all(cancel.clone()), cancel_soon(&cancel));
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    #[cfg(unix)]
    fixture.assert_stopped("cancelled").await;
    manager.close().await.unwrap();
    let manager = McpManager::new(
        vec![fixture.config("shutdown", "hang", 30000)],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    let close = async {
        fixture.wait_file("shutdown.pid").await;
        manager.close().await.unwrap();
    };
    let (connected, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(manager.connect_all(flag()), close)
    })
    .await
    .unwrap();
    assert_eq!(
        connected.unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    #[cfg(unix)]
    fixture.assert_stopped("shutdown").await;
}

#[tokio::test]
async fn cancelled_scoped_reconnect_preserves_survivor_and_allows_retry() {
    let fixture = Fixture::new();
    let manager = McpManager::new(
        vec![
            fixture.config("good", "", 2000),
            fixture.config("retry", "retry", 30000),
        ],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    std::fs::write(fixture.root.join("retry.ready"), "ready").unwrap();
    manager.connect_all(flag()).await.unwrap();
    assert!(
        manager
            .servers()
            .iter()
            .all(|server| server.state == ConnectionState::Connected)
    );
    std::fs::remove_file(fixture.root.join("retry.ready")).unwrap();
    std::fs::remove_file(fixture.root.join("retry.child")).unwrap();
    let survivor_pid = fixture.wait_file("good.pid").await;
    let cancel = flag();
    let cancel_started = async {
        fixture.wait_file("retry.child").await;
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    };
    let (result, ()) = tokio::join!(
        manager.reconnect(Some("retry"), cancel.clone()),
        cancel_started
    );
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    #[cfg(unix)]
    fixture.assert_stopped("retry").await;
    let survivor = manager.servers()[0].state;
    let resource = manager
        .read_resource(
            ResourceRequest {
                server: "good".into(),
                uri: "fixture://one".into(),
            },
            &AtomicBool::new(false),
        )
        .await;
    std::fs::write(fixture.root.join("retry.ready"), "ready").unwrap();
    let retry = manager.reconnect(Some("retry"), flag()).await;
    let retried = manager.servers()[1].state;
    manager.close().await.unwrap();
    assert_eq!(survivor, ConnectionState::Connected);
    assert!(resource.unwrap().contains("resource text"));
    assert_eq!(fixture.wait_file("good.pid").await, survivor_pid);
    retry.unwrap();
    assert_eq!(retried, ConnectionState::Connected);
    #[cfg(unix)]
    fixture.assert_stopped("retry").await;
}

#[tokio::test]
async fn shutdown_allows_eof_flush_and_bounds_concurrent_unresponsive_servers() {
    let fixture = Fixture::new();
    let manager = McpManager::new(
        vec![
            fixture.config("flush", "flush", 2000),
            fixture.config("first", "unresponsive", 2000),
            fixture.config("second", "unresponsive", 2000),
        ],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    manager.connect_all(flag()).await.unwrap();
    assert!(
        manager
            .servers()
            .iter()
            .all(|server| server.state == ConnectionState::Connected)
    );
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), manager.close())
        .await
        .unwrap()
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    #[cfg(unix)]
    for id in ["flush", "first", "second"] {
        fixture.assert_stopped(id).await;
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("flush.flush")).unwrap(),
        "flushed"
    );
    assert!(!fixture.root.join("flush.lock").exists());
}

#[tokio::test]
async fn cancellation_timeout_and_shutdown_settle_pending_requests() {
    let fixture = Fixture::new();
    let manager = McpManager::new(
        vec![fixture.config("good", "", 250)],
        "test".into(),
        "1".into(),
    )
    .unwrap();
    manager.connect_all(flag()).await.unwrap();
    let call = manager.start_tool_call(request("slow", json!({}))).unwrap();
    let cancel = flag();
    let (result, ()) = tokio::join!(call.result(&cancel), cancel_soon(&cancel));
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    assert_eq!(fixture.wait_file("good.cancel").await, "cancelled");
    let call = manager.start_tool_call(request("slow", json!({}))).unwrap();
    assert_eq!(
        call.result(&AtomicBool::new(false))
            .await
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::TimedOut
    );
    for prompt in [false, true] {
        let cancel = flag();
        let request = async {
            if prompt {
                manager
                    .get_prompt(
                        PromptRequest {
                            server: "good".into(),
                            name: "slow".into(),
                            arguments: None,
                        },
                        &cancel,
                    )
                    .await
            } else {
                manager
                    .read_resource(
                        ResourceRequest {
                            server: "good".into(),
                            uri: "fixture://slow".into(),
                        },
                        &cancel,
                    )
                    .await
            }
        };
        let (result, ()) = tokio::join!(request, cancel_soon(&cancel));
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    }
    let call = manager.start_tool_call(request("slow", json!({}))).unwrap();
    manager.close().await.unwrap();
    assert!(call.result(&AtomicBool::new(false)).await.is_err());
    #[cfg(unix)]
    fixture.assert_stopped("good").await;
}
