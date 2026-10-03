#[path = "lsp/support.rs"]
mod support;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(unix)]
use serde_json::Value;
use serde_json::json;
use support::Fixture;
use xal_services::lsp::{Manager, Operation, Query, ServerDefinition, parse_config};

#[test]
fn configuration_recipes_overrides_strictness_expansion_and_discovery() {
    let parsed = parse_config(&json!({}).as_object().unwrap().clone(), &BTreeMap::new()).unwrap();
    assert_eq!(parsed.servers.len(), 4);
    let ServerDefinition::Enabled { server } = &parsed.servers[0] else {
        panic!()
    };
    assert_eq!(server.id, "typescript");
    assert_eq!(server.file_types.len(), 8);
    assert_eq!(server.args, ["--stdio"]);
    assert_eq!(server.timeout_ms, 30_000);
    assert!(server.install.as_ref().unwrap().contains("npm install"));
    let value = json!({"servers":{"typescript":{"enabled":false},"custom":{"command":"${BIN}","args":["${TOKEN}"],"fileTypes":{".ts":"typescript"},"env":{"API_KEY":"prefix-${VALUE}","PLAIN":"${TOKEN}"}}}});
    let env = BTreeMap::from([
        ("BIN".into(), "fixture".into()),
        ("TOKEN".into(), "secret-argument".into()),
        ("VALUE".into(), "secret-value".into()),
    ]);
    let parsed = parse_config(value.as_object().unwrap(), &env).unwrap();
    assert!(parsed.secrets.contains(&"secret-argument".into()));
    assert!(parsed.secrets.contains(&"secret-value".into()));
    assert!(parsed.secrets.contains(&"prefix-secret-value".into()));
    let serialized = serde_json::to_string(&parsed.servers).unwrap();
    let _: Vec<ServerDefinition> = serde_json::from_str(&serialized).unwrap();
    for invalid in [
        json!({"extra":true}),
        json!({"servers":null}),
        json!({"servers":{"Bad":{"enabled":false}}}),
        json!({"servers":{"python":{"args":null}}}),
        json!({"servers":{"python":{"rootMarkers":[]}}}),
        json!({"servers":{"python":{"timeoutMs":0}}}),
        json!({"servers":{"python":{"settings":null}}}),
        json!({"servers":{"python":{"command":"relative/path"}}}),
        json!({"servers":{"python":{"enabled":false,"typo":true}}}),
        json!({"servers":{"custom":{"command":"server","fileTypes":{".ts":"typescript"}}}}),
        json!({"servers":{"python":{"args":["${MISSING}"]}}}),
    ] {
        assert!(
            parse_config(invalid.as_object().unwrap(), &env).is_err(),
            "{invalid}"
        );
    }
    let fixture = Fixture::new();
    let mut config = fixture.config("full");
    config.command = "definitely-missing-xal-lsp".into();
    config.env.insert(
        "PATH".into(),
        fixture.root.join("missing-bin").to_str().unwrap().into(),
    );
    let manager = Manager::new(
        vec![ServerDefinition::Enabled {
            server: Box::new(config),
        }],
        "fixture".into(),
        "1".into(),
    )
    .unwrap();
    assert!(!manager.has_available_server(&fixture.root));
    assert!(manager.status_lines(&fixture.root)[0].contains("unavailable"));
    assert!(fixture.manager("full").has_available_server(&fixture.root));
}

#[test]
fn relative_path_availability_is_resolved_at_the_selected_root() {
    let fixture = Fixture::new();
    let bin = fixture.root.join("node_modules/.bin");
    let cwd = fixture.root.join("src");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    std::fs::write(fixture.root.join("package.json"), "{}").unwrap();
    std::fs::write(cwd.join("source.fake"), "nested").unwrap();
    let executable = bin.join(fixture.executable.file_name().unwrap());
    std::fs::copy(&fixture.executable, &executable).unwrap();
    let mut config = fixture.config("full");
    config.command = executable.file_name().unwrap().to_str().unwrap().into();
    config.env.insert("PATH".into(), "node_modules/.bin".into());
    config.root_markers = vec!["package.json".into()];
    let manager = Manager::new(
        vec![ServerDefinition::Enabled {
            server: Box::new(config),
        }],
        "fixture".into(),
        "1".into(),
    )
    .unwrap();
    assert!(manager.has_available_server(&cwd));
    assert!(fixture.messages("full").is_empty());
    manager
        .query(&fixture.query(Operation::Hover), &cwd, &|| false)
        .unwrap();
    assert!(manager.has_available_server(&cwd));
    assert_eq!(
        fixture.messages("full")[1]["params"]["rootUri"],
        reqwest13::Url::from_directory_path(&fixture.root)
            .unwrap()
            .as_str()
            .trim_end_matches('/')
    );
    manager.close().unwrap();
    assert!(!manager.has_available_server(&cwd));
    std::fs::remove_file(executable).unwrap();
    let mut config = fixture.config("full");
    config.command = "definitely-missing-xal-lsp".into();
    config.env.insert("PATH".into(), "node_modules/.bin".into());
    let manager = Manager::new(
        vec![ServerDefinition::Enabled {
            server: Box::new(config),
        }],
        "fixture".into(),
        "1".into(),
    )
    .unwrap();
    assert!(manager.has_available_server(&cwd));
    assert!(
        manager
            .query(&fixture.query(Operation::Hover), &cwd, &|| false)
            .unwrap_err()
            .to_string()
            .contains("unavailable")
    );
    manager.close().unwrap();
}

#[cfg(unix)]
#[test]
fn active_clients_remain_available_after_the_executable_is_removed() {
    let fixture = Fixture::new();
    let manager = fixture.manager("full");
    manager
        .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
        .unwrap();
    std::fs::remove_file(&fixture.executable).unwrap();
    assert!(manager.has_available_server(&fixture.root));
    manager
        .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
        .unwrap();
    manager.restart(None).unwrap();
    assert!(!manager.has_available_server(&fixture.root));
    manager.close().unwrap();
}

#[cfg(unix)]
struct DetachedHelper {
    pid: i32,
}

#[cfg(unix)]
impl DetachedHelper {
    fn new(fixture: &Fixture, mode: &str) -> Self {
        fixture.wait_for(mode, |message| message.get("detached").is_some());
        let pid = fixture
            .messages(mode)
            .iter()
            .rev()
            .find_map(|message| message.get("detached").and_then(Value::as_i64))
            .unwrap();
        let helper = Self {
            pid: i32::try_from(pid).unwrap(),
        };
        assert_eq!(unsafe { libc::getsid(helper.pid) }, helper.pid);
        helper
    }
}

#[cfg(unix)]
impl Drop for DetachedHelper {
    fn drop(&mut self) {
        assert_eq!(unsafe { libc::kill(self.pid, libc::SIGKILL) }, 0);
        let deadline = Instant::now() + Duration::from_secs(3);
        while support::process_running(u32::try_from(self.pid).unwrap()) {
            assert!(Instant::now() < deadline, "detached helper remains running");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
#[test]
fn detached_helpers_cannot_block_owned_pipe_cleanup() {
    let fixture = Fixture::new();
    for (action, behavior) in [
        ("cancel", "hang-query"),
        ("cancel", "block-input"),
        ("timeout", "block-input"),
        ("restart", "full"),
        ("close", "full"),
        ("restart", "block-input"),
        ("close", "block-input"),
    ] {
        let mode = format!("detached-{action}-{behavior}");
        let manager = Arc::new(fixture.manager(&mode));
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_manager = manager.clone();
        let worker_cancel = cancel.clone();
        let cwd = fixture.root.clone();
        let query = fixture.query(Operation::Hover);
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender
                .send(worker_manager.query(&query, &cwd, &|| worker_cancel.load(Ordering::Acquire)))
                .unwrap();
        });
        let helper = DetachedHelper::new(&fixture, &mode);
        if behavior == "full" {
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
        } else if behavior == "hang-query" {
            fixture.wait_for(&mode, |message| message["method"] == "textDocument/hover");
        }
        let (stopped, cleanup) = std::sync::mpsc::channel();
        let stopping = manager.clone();
        let cleanup_worker = std::thread::spawn(move || {
            let result = match action {
                "cancel" => {
                    cancel.store(true, Ordering::Release);
                    Ok(())
                }
                "timeout" => Ok(()),
                "restart" => stopping.restart(None),
                "close" => stopping.close(),
                _ => unreachable!(),
            };
            stopped.send(result).unwrap();
        });
        let result = if behavior == "full" {
            None
        } else {
            Some(receiver.recv_timeout(Duration::from_secs(2)))
        };
        let cleanup_result = cleanup.recv_timeout(Duration::from_secs(2));
        drop(helper);
        worker.join().unwrap();
        cleanup_worker.join().unwrap();
        cleanup_result.unwrap().unwrap();
        if let Some(result) = result {
            assert_eq!(
                result.unwrap().unwrap_err().kind(),
                if action == "timeout" {
                    std::io::ErrorKind::TimedOut
                } else {
                    std::io::ErrorKind::Interrupted
                },
                "{mode}"
            );
        }
        manager.close().unwrap();
        fixture.assert_stopped(&mode);
    }
}

#[test]
fn all_queries_sync_utf16_configuration_and_read_only_server_requests() {
    let fixture = Fixture::new();
    let manager = fixture.manager("incremental");
    assert!(manager.status_lines(&fixture.root)[0].contains("idle"));
    assert!(fixture.messages("incremental").is_empty());
    for (operation, expected) in [
        (Operation::Hover, "Hover information\none\r\ntwo😀"),
        (Operation::Definition, "Found 1 definition"),
        (Operation::References, "Found 1 reference"),
        (Operation::Implementation, "Found 1 implementation"),
        (Operation::DocumentSymbols, "Found 2 symbols"),
        (Operation::WorkspaceSymbols, "Found 1 symbol"),
        (Operation::IncomingCalls, "Found 1 incoming call"),
        (Operation::OutgoingCalls, "Found 1 outgoing call"),
        (Operation::Diagnostics, "Found 1 diagnostic"),
    ] {
        assert!(
            manager
                .query(&fixture.query(operation), &fixture.root, &|| false)
                .unwrap()
                .starts_with(expected)
        );
    }
    std::fs::write(fixture.root.join("source.fake"), "changed😀").unwrap();
    assert_eq!(
        manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
            .unwrap(),
        "Hover information\nchanged😀"
    );
    let messages = fixture.messages("incremental");
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["method"] == "initialize")
            .count(),
        1
    );
    let init = messages
        .iter()
        .find(|message| message["method"] == "initialize")
        .unwrap();
    assert_eq!(
        init["params"]["capabilities"]["general"]["positionEncodings"],
        json!(["utf-16"])
    );
    assert_eq!(
        init["params"]["initializationOptions"],
        json!({"fixture":true})
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["method"] == "textDocument/hover")
            .unwrap()["params"]["position"],
        json!({"line":1,"character":3})
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["method"] == "textDocument/didChange")
            .unwrap()["params"]["contentChanges"][0]["range"]["end"],
        json!({"line":1,"character":5})
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["id"] == "config")
            .unwrap()["result"],
        json!([42,{"fixture":{"nested":42}}])
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["id"] == "edit")
            .unwrap()["error"]["code"],
        -32601
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["method"] == "workspace/symbol")
            .unwrap()["params"]["query"],
        "workspace"
    );
    assert!(manager.status_lines(&fixture.root)[0].contains("ready"));
    manager.restart(Some("fixture")).unwrap();
    assert!(manager.status_lines(&fixture.root)[0].contains("idle"));
    fixture.assert_stopped("incremental");
    manager.close().unwrap();
    assert!(
        manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
            .is_err()
    );
}

#[test]
fn pull_diagnostics_cache_and_document_sync_modes() {
    let fixture = Fixture::new();
    for mode in ["pull", "full", "reopen", "save-only", "no-diagnostics"] {
        let manager = fixture.manager(mode);
        let query = fixture.query(Operation::Diagnostics);
        let output = manager.query(&query, &fixture.root, &|| false).unwrap();
        if mode == "pull" {
            assert!(output.contains("warning [fixture 42]: pull diagnostic"));
            assert_eq!(
                manager.query(&query, &fixture.root, &|| false).unwrap(),
                output
            );
            assert!(
                fixture
                    .messages(mode)
                    .iter()
                    .any(|message| message["params"]["previousResultId"] == "1")
            );
        } else if ["no-diagnostics", "save-only"].contains(&mode) {
            assert!(output.contains("before the 1.5s deadline"));
        }
        std::fs::write(fixture.root.join("source.fake"), format!("updated-{mode}")).unwrap();
        manager.query(&query, &fixture.root, &|| false).unwrap();
        let messages = fixture.messages(mode);
        match mode {
            "full" | "save-only" => {
                let change = messages
                    .iter()
                    .find(|message| message["method"] == "textDocument/didChange")
                    .unwrap();
                assert!(change["params"]["contentChanges"][0].get("range").is_none());
            }
            "reopen" => assert_eq!(
                messages
                    .iter()
                    .filter(|message| message["method"] == "textDocument/didOpen")
                    .count(),
                2
            ),
            "pull" => assert!(
                messages
                    .iter()
                    .rfind(|message| message["method"] == "textDocument/diagnostic")
                    .unwrap()["params"]
                    .get("previousResultId")
                    .is_none()
            ),
            _ => {}
        }
        if mode == "save-only" {
            assert!(
                !messages
                    .iter()
                    .any(|message| message["method"] == "textDocument/didOpen")
            );
            assert!(
                messages
                    .iter()
                    .any(|message| message["method"] == "textDocument/didSave")
            );
        }
        manager.close().unwrap();
        fixture.assert_stopped(mode);
    }
}

#[test]
fn nearest_roots_workspace_fallback_and_external_files_are_lazy_and_independent() {
    let fixture = Fixture::new();
    let manager = fixture.manager("full");
    let nested = fixture.root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join(".fixture-root"), "").unwrap();
    std::fs::write(nested.join("source.fake"), "nested").unwrap();
    for path in ["source.fake", "nested/source.fake"] {
        let mut query = fixture.query(Operation::Hover);
        query.file_path = path.into();
        manager.query(&query, &fixture.root, &|| false).unwrap();
    }
    assert_eq!(manager.status_lines(&fixture.root).len(), 2);
    let roots = fixture
        .messages("full")
        .iter()
        .filter(|message| message["method"] == "initialize")
        .map(|message| message["params"]["rootUri"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(roots.iter().any(|root| root.ends_with("/nested")));
    manager.close().unwrap();
    std::fs::remove_file(fixture.root.join(".fixture-root")).unwrap();
    std::fs::remove_file(nested.join(".fixture-root")).unwrap();
    let manager = fixture.manager("reopen");
    let mut query = fixture.query(Operation::Hover);
    query.file_path = fixture.root.join("source.fake").to_str().unwrap().into();
    manager.query(&query, &nested, &|| false).unwrap();
    let mut query = fixture.query(Operation::Hover);
    query.file_path = "nested/source.fake".into();
    manager.query(&query, &fixture.root, &|| false).unwrap();
    assert_eq!(manager.status_lines(&fixture.root).len(), 1);
    manager.close().unwrap();
}

#[test]
fn cancellation_timeout_failure_and_cleanup_cover_initialize_queries_and_owned_descendants() {
    let fixture = Fixture::new();
    for mode in ["hang-init", "hang-query", "block-input"] {
        let manager = Arc::new(fixture.manager(mode));
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_manager = manager.clone();
        let worker_cancel = cancel.clone();
        let cwd = fixture.root.clone();
        let query = fixture.query(Operation::Hover);
        let worker = std::thread::spawn(move || {
            worker_manager.query(&query, &cwd, &|| worker_cancel.load(Ordering::Acquire))
        });
        fixture.wait_for(mode, |message| match mode {
            "hang-init" => message["method"] == "initialize",
            "hang-query" => message["method"] == "textDocument/hover",
            "block-input" => message.get("pid").is_some(),
            _ => unreachable!(),
        });
        let before = Instant::now();
        cancel.store(true, Ordering::Release);
        assert_eq!(
            worker.join().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
        assert!(before.elapsed() < Duration::from_secs(2));
        manager.close().unwrap();
        fixture.assert_stopped(mode);
    }
    for mode in [
        "fail-tree",
        "encoding",
        "malformed",
        "crash",
        "bad-result",
        "rpc-error",
        "block-input",
    ] {
        let manager = fixture.manager(mode);
        let before = Instant::now();
        let error = manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
            .unwrap_err();
        assert!(!error.to_string().is_empty());
        if mode == "block-input" {
            assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
            assert!(error.to_string().contains("stdin timed out"));
            assert!(before.elapsed() < Duration::from_secs(3));
        }
        assert!(manager.status_lines(&fixture.root)[0].contains("failed"));
        manager.close().unwrap();
        fixture.assert_stopped(mode);
    }
    let manager = fixture.manager("hang-query");
    assert_eq!(
        manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::TimedOut
    );
    manager.close().unwrap();
    fixture.assert_stopped("hang-query");
    let manager = fixture.manager("tree");
    manager
        .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
        .unwrap();
    manager.close().unwrap();
    fixture.assert_stopped("tree");
}

#[test]
fn close_interrupts_inflight_requests_and_joins_concurrent_restart_cleanup() {
    let fixture = Fixture::new();
    let manager = Arc::new(fixture.manager("hang-query"));
    let worker_manager = manager.clone();
    let cwd = fixture.root.clone();
    let query = fixture.query(Operation::Hover);
    let worker = std::thread::spawn(move || worker_manager.query(&query, &cwd, &|| false));
    fixture.wait_for("hang-query", |message| {
        message["method"] == "textDocument/hover"
    });
    manager.close().unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    fixture.assert_stopped("hang-query");
    let manager = Arc::new(fixture.manager("hang-shutdown"));
    manager
        .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
        .unwrap();
    let restarting = manager.clone();
    let worker = std::thread::spawn(move || restarting.restart(None));
    fixture.wait_for("hang-shutdown", |message| message["method"] == "shutdown");
    assert_eq!(
        manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| false)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Interrupted
    );
    manager.close().unwrap();
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("shutdown")
    );
    fixture.assert_stopped("hang-shutdown");
    assert_eq!(
        fixture
            .messages("hang-shutdown")
            .iter()
            .filter(|message| message.get("pid").is_some())
            .count(),
        1
    );
}

#[test]
fn invalid_queries_and_nonregular_files_fail_before_spawning() {
    let fixture = Fixture::new();
    let manager = fixture.manager("full");
    for value in [
        json!({"operation":"invalid","filePath":"source.fake"}),
        json!({"operation":"hover","filePath":"source.fake"}),
        json!({"operation":"workspace_symbols","filePath":"source.fake","query":" "}),
        json!({"operation":"hover","filePath":"source.fake","line":0,"column":1}),
        json!({"operation":"diagnostics","filePath":"source.fake","unknown":true}),
    ] {
        let result = serde_json::from_value::<Query>(value)
            .map_err(std::io::Error::other)
            .and_then(|query| manager.query(&query, &fixture.root, &|| false));
        assert!(result.is_err());
    }
    let mut query = fixture.query(Operation::Diagnostics);
    query.file_path = ".".into();
    assert!(manager.query(&query, &fixture.root, &|| false).is_err());
    assert!(
        manager
            .query(&fixture.query(Operation::Hover), &fixture.root, &|| true)
            .is_err()
    );
    assert!(fixture.messages("full").is_empty());
    manager.close().unwrap();
}
