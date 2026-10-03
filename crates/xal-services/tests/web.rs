use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use xal_services::web::{FetchRequest, fetch, subject};

async fn server(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/path", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream.write_all(&response).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn html_charset_redirect_errors_and_body_limits_are_native() {
    for (headers, body, expected) in [
        (
            "200 OK\r\nContent-Type: TEXT/HTML",
            "<h1>Hello</h1><script>bad</script><p>world</p>",
            Ok("# Hello\n\nworld"),
        ),
        (
            "200 OK\r\nContent-Type: text/plain",
            "",
            Ok("(empty response)"),
        ),
        (
            "302 Found\r\nLocation: /elsewhere",
            "not followed",
            Ok("Redirected to "),
        ),
        (
            "403 Forbidden\r\nContent-Type: text/plain",
            "denied",
            Err("403 Forbidden"),
        ),
        (
            "200 OK\r\nContent-Type: IMAGE/PNG",
            "binary",
            Err("Cannot fetch binary content"),
        ),
        (
            "200 OK\r\nContent-Type: text/plain",
            "x\0y",
            Err("Cannot fetch binary content"),
        ),
    ] {
        let response = format!(
            "HTTP/1.1 {headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes();
        let (url, task) = server(response).await;
        let result = fetch(
            &FetchRequest {
                url: Some(url),
                user_agent: "fixture".into(),
                allow_internal: Some(true),
            },
            &AtomicBool::new(false),
        )
        .await;
        match expected {
            Ok(text) => assert!(result.unwrap().starts_with(text)),
            Err(text) => assert!(result.unwrap_err().to_string().contains(text)),
        }
        task.await.unwrap();
    }
    let mut response = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=windows-1252\r\nContent-Length: 1\r\nConnection: close\r\n\r\n".to_vec();
    response.push(0xe9);
    let (url, task) = server(response).await;
    assert_eq!(
        fetch(
            &FetchRequest {
                url: Some(url),
                user_agent: "fixture".into(),
                allow_internal: Some(true)
            },
            &AtomicBool::new(false)
        )
        .await
        .unwrap(),
        "é"
    );
    task.await.unwrap();
    let body = "x".repeat(5 * 1024 * 1024 + 1);
    let (url, task) = server(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes(),
    )
    .await;
    assert!(
        fetch(
            &FetchRequest {
                url: Some(url),
                user_agent: "fixture".into(),
                allow_internal: Some(true)
            },
            &AtomicBool::new(false)
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("5 MB limit")
    );
    task.await.unwrap();
}

#[tokio::test]
async fn private_targets_and_credentials_subjects_are_checked_before_network_use() {
    for url in [
        "http://127.0.0.1",
        "http://[::1]",
        "http://[::ffff:127.0.0.1]",
        "http://10.0.0.1",
        "file:///tmp/text",
    ] {
        let error = fetch(
            &FetchRequest {
                url: Some(url.into()),
                user_agent: "fixture".into(),
                allow_internal: None,
            },
            &AtomicBool::new(false),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains(if url.starts_with("file:") {
                "Not a valid"
            } else {
                "internal address"
            }),
            "{error}"
        );
    }
    assert_eq!(
        subject("https://user:password@example.com/path?q=1"),
        "https://example.com/path?q=1"
    );
}

#[tokio::test]
async fn cancellation_releases_a_stalled_http_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        signal.store(true, Ordering::Relaxed);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        fetch(
            &FetchRequest {
                url: Some(url),
                user_agent: "fixture".into(),
                allow_internal: Some(true),
            },
            &cancel,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(result.contains("interrupted"));
    task.await.unwrap();
}
