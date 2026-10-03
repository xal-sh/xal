use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use xal_services::records::Record;

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "xal-headless-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let cwd = root.join("workspace");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        fs::write(home.join("credentials.json"), json!({"profiles":{"fixture":{"name":"Fixture","provider":"openai","credential":{"type":"api_key","key":"fixture-secret"}}}}).to_string()).unwrap();
        Self { root, home, cwd }
    }

    fn command(&self, server: &Server, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xal-rust"));
        command
            .args(["run", "--model", "gpt-4.1"])
            .args(args)
            .current_dir(&self.cwd)
            .env("XAL_HOME", &self.home)
            .env("HOME", &self.home)
            .env("SHELL", "/bin/sh")
            .env("XAL_OPENAI_BASE_URL", &server.url)
            .env("NO_PROXY", "*")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, server: &Server, args: &[&str], input: &str) -> Output {
        let mut child = self.command(server, args).spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let out = thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let err = thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!(
                    "native run did not settle: args={args:?} requests={} stdout={} stderr={}",
                    server.requests().len(),
                    String::from_utf8_lossy(&out.join().unwrap()),
                    String::from_utf8_lossy(&err.join().unwrap())
                );
            }
            thread::sleep(Duration::from_millis(10));
        };
        Output {
            status,
            stdout: out.join().unwrap(),
            stderr: err.join().unwrap(),
        }
    }

    fn journals(&self) -> Vec<PathBuf> {
        fn visit(path: &std::path::Path, result: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, result);
                } else if path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
                {
                    result.push(path);
                }
            }
        }
        let mut result = Vec::new();
        let sessions = self.home.join("sessions");
        if sessions.exists() {
            visit(&sessions, &mut result);
        }
        result
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new(replies: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let collected = requests.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            for reply in replies {
                let (mut socket, _) = loop {
                    if stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    match listener.accept() {
                        Ok(socket) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut request = Vec::new();
                let mut bytes = [0; 8192];
                let (end, length) = loop {
                    let count = socket.read(&mut bytes).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&bytes[..count]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        assert!(header.starts_with("post /v1/responses "));
                        assert!(header.contains("authorization: bearer fixture-secret"));
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while request.len() < end + length {
                    let count = socket.read(&mut bytes).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&bytes[..count]);
                }
                collected
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&request[end..end + length]).unwrap());
                let response = if reply.starts_with("HTTP/") {
                    reply
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                };
                for chunk in response.as_bytes().chunks(17) {
                    if socket.write_all(chunk).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Err(error) = self.worker.take().unwrap().join()
            && !thread::panicking()
        {
            std::panic::resume_unwind(error);
        }
    }
}

fn event(value: Value) -> String {
    format!("data: {value}\r\n\r\n")
}
fn done() -> String {
    event(
        json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}}}}),
    )
}
fn call(id: &str, name: &str, args: Value) -> String {
    event(
        json!({"type":"response.output_item.done","item":{"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"}}),
    )
}
fn answer(text: &str) -> String {
    event(json!({"type":"response.output_text.delta","delta":text}))
        + &event(
            json!({"type":"response.output_item.done","item":{"type":"message","id":"msg_fixture","role":"assistant","content":[{"type":"output_text","text":text}],"status":"completed"}}),
        )
        + &done()
}
fn json_output(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
fn events(output: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn thinking_preferences_round_trip_the_selected_alias() {
    let fixture = Fixture::new();
    xal_services::storage::write_json(
        &fixture.home.join("config.json"),
        &json!({"provider":"openai","profile":"fixture","model":"gpt-5.6-1m"}),
    )
    .unwrap();
    xal_services::storage::write_json(
        &fixture.home.join("cache/openai-models-fixture.json"),
        &json!({"version":1,"models":["gpt-5.6"]}),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_xal-rust"))
        .args(["thinking", "high"])
        .env("XAL_HOME", &fixture.home)
        .env("HOME", &fixture.home)
        .current_dir(&fixture.cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved = xal_services::storage::read_json(&fixture.home.join("config.json"))
        .unwrap()
        .unwrap();
    assert_eq!(saved["thinking"]["openai"], json!({"gpt-5.6-1m":"high"}));
    let server = Server::new(vec![answer("selected effort")]);
    let output = fixture.run(&server, &["--model", "gpt-5.6-1m", "fixture prompt"], "");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests()[0]["reasoning"]["effort"], "high");
}

#[test]
fn reads_edits_verifies_and_records_legacy_jsonl() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("sample.txt"), "before\n").unwrap();
    let server = Server::new(vec![
        call("read", "read", json!({"file_path":"sample.txt"})) + &done(),
        call(
            "edit",
            "edit",
            json!({"file_path":"sample.txt","old_string":"before","new_string":"after"}),
        ) + &done(),
        call("verify", "read", json!({"file_path":"sample.txt"})) + &done(),
        answer("Verified ✓"),
    ]);
    let output = fixture.run(&server, &["--format", "jsonl", "read edit verify"], "");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("sample.txt")).unwrap(),
        "after\n"
    );
    let events = events(&output);
    assert_eq!(events[0]["type"], "session_started");
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "assistant_message" && event["text"] == "Verified ✓")
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "tool_finished")
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .find(|event| event["type"] == "turn_ended")
            .unwrap()["usage"]["totalInputTokens"],
        480
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[1]["input"][1]["type"], "function_call");
    assert!(
        requests[3]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "function_call_output"
                && item["output"].as_str().unwrap().contains("after"))
    );
    let journals = fixture.journals();
    assert_eq!(journals.len(), 1);
    let journal = fs::read_to_string(&journals[0]).unwrap();
    for line in journal.lines() {
        Record::parse(line).unwrap();
    }
    assert!(!journal.contains("fixture-secret"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&journals[0]).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn tool_event_titles_keep_arguments_and_full_multiline_shell_commands() {
    let fixture = Fixture::new();
    let command = "set -e\nprintf 'first\\n'\nprintf 'second\\n'";
    let server = Server::new(vec![
        call("memory", "memory", json!({"operation":"read"}))
            + &call("shell", "bash", json!({"command":command}))
            + &call("web", "webfetch", json!({"url":"invalid://fixture-secret"}))
            + &call("invalid", "memory", json!({"operation":false}))
            + &done(),
        answer("done"),
    ]);
    let output = fixture.run(
        &server,
        &["--format", "jsonl", "--mode", "yolo", "inspect"],
        "",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let emitted = events(&output);
    for (id, title) in [
        ("memory", "Read global memory"),
        ("shell", command),
        ("web", "invalid://[REDACTED]"),
    ] {
        for kind in ["tool_started", "tool_finished"] {
            let event = emitted
                .iter()
                .find(|event| event["type"] == kind && event["callId"] == id)
                .unwrap();
            assert_eq!(event["title"], title);
        }
    }
    let invalid = emitted
        .iter()
        .find(|event| event["type"] == "tool_finished" && event["callId"] == "invalid")
        .unwrap();
    assert_eq!(invalid["title"], "Global memory");
    assert!(
        invalid["output"]
            .as_str()
            .unwrap()
            .starts_with("Tool failed:")
    );
    fs::write(
        fixture.home.join("config.json"),
        json!({"permissions":{"ask":["bash"]}}).to_string(),
    )
    .unwrap();
    let denied = Server::new(vec![
        call("approval", "bash", json!({"command":command})) + &done(),
        answer("not run"),
    ]);
    let output = fixture.run(
        &denied,
        &["--format", "jsonl", "--mode", "normal", "inspect"],
        "",
    );
    assert!(output.status.success());
    assert!(
        events(&output)
            .iter()
            .any(|event| event["type"] == "approval_requested" && event["title"] == command)
    );
}

#[test]
fn stdin_formats_redaction_and_retry_preserve_automation_contract() {
    let fixture = Fixture::new();
    let server = Server::new(vec!["HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\nRetry-After: 0\r\nConnection: close\r\n\r\n{}".into(), answer("fixture-secret accepted")]);
    let output = fixture.run(&server, &["--format", "json"], "  from stdin  \n");
    assert!(output.status.success());
    let value = json_output(&output);
    assert_eq!(value["status"], "completed");
    assert_eq!(value["response"], "[REDACTED] accepted");
    assert!(value["sessionId"].is_string());
    assert!(String::from_utf8_lossy(&output.stderr).contains("retrying"));
    assert_eq!(
        server.requests()[0]["input"][0]["content"][0]["text"],
        "from stdin"
    );
    let server = Server::new(vec![answer("text only")]);
    let output = fixture.run(&server, &["--", "-prompt"], "");
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "text only\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn denies_without_effects_and_rejects_malformed_arguments() {
    for mode in ["normal", "plan", "yolo"] {
        let fixture = Fixture::new();
        fs::write(
            fixture.home.join("config.json"),
            json!({"permissions":{"deny":["write(blocked.txt)"]}}).to_string(),
        )
        .unwrap();
        let server = Server::new(vec![
            call(
                "denied",
                "write",
                json!({"file_path":"blocked.txt","content":"bad"}),
            ) + &call(
                "invalid",
                "write",
                json!({"file_path":"invalid.txt","content":3}),
            ) + &done(),
            answer("not changed"),
        ]);
        let output = fixture.run(
            &server,
            &["--format", "jsonl", "--mode", mode, "try writes"],
            "",
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(!fixture.cwd.join("blocked.txt").exists());
        assert!(!fixture.cwd.join("invalid.txt").exists());
        assert!(
            events(&output)
                .iter()
                .any(|event| event["type"] == "tool_finished"
                    && event["callId"] == "denied"
                    && event["denial"].is_string())
        );
    }
}

#[test]
fn partial_stream_retains_text_but_never_executes_tools_or_retries() {
    let fixture = Fixture::new();
    let server = Server::new(vec![
        event(json!({"type":"response.output_text.delta","delta":"partial"}))
            + &call(
                "write",
                "write",
                json!({"file_path":"bad.txt","content":"bad"}),
            ),
    ]);
    let output = fixture.run(&server, &["--format", "json", "try"], "");
    assert_eq!(output.status.code(), Some(1));
    let value = json_output(&output);
    assert_eq!(value["status"], "failed");
    assert_eq!(value["response"], "partial");
    assert!(!fixture.cwd.join("bad.txt").exists());
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn schema_success_and_three_attempt_failure() {
    for valid in [false, true] {
        let fixture = Fixture::new();
        fs::write(fixture.cwd.join("schema.json"), json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}).to_string()).unwrap();
        let replies = if valid {
            vec![call("output", "submit_output", json!({"ok":true})) + &done()]
        } else {
            (0..3)
                .map(|index| {
                    call(
                        &format!("output{index}"),
                        "submit_output",
                        json!({"ok":"wrong"}),
                    ) + &done()
                })
                .collect()
        };
        let server = Server::new(replies);
        let output = fixture.run(
            &server,
            &[
                "--format",
                "json",
                "--output-schema",
                "schema.json",
                "answer",
            ],
            "",
        );
        let value = json_output(&output);
        assert_eq!(output.status.success(), valid, "{value}");
        if valid {
            assert_eq!(value["response"], json!({"ok":true}));
        } else {
            assert!(
                value["error"]
                    .as_str()
                    .unwrap()
                    .contains("after 3 attempts")
            );
        }
    }
}

#[test]
fn context_overflow_refuses_before_provider_request() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        json!({"pluginConfig":{"openai":{"contextWindow":100}}}).to_string(),
    )
    .unwrap();
    let server = Server::new(Vec::new());
    let output = fixture.run(&server, &["--format", "json", "too large"], "");
    assert_eq!(output.status.code(), Some(1));
    assert!(
        json_output(&output)["error"]
            .as_str()
            .unwrap()
            .contains("context overflow")
    );
    assert!(server.requests().is_empty());
}

#[test]
#[cfg(unix)]
fn stale_writes_are_refused_after_external_shell_changes() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("sample.txt"), "original").unwrap();
    let server = Server::new(vec![
        call("read", "read", json!({"file_path":"sample.txt"})) + &done(),
        call(
            "change",
            "bash",
            json!({"command":"printf changed > sample.txt"}),
        ) + &done(),
        call(
            "write",
            "write",
            json!({"file_path":"sample.txt","content":"stale"}),
        ) + &done(),
        answer("stale write refused"),
    ]);
    let output = fixture.run(&server, &["--format", "jsonl", "check stale"], "");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("sample.txt")).unwrap(),
        "changed"
    );
    assert!(events(&output).iter().any(|event| {
        event["type"] == "tool_finished"
            && event["callId"] == "write"
            && event["output"]
                .as_str()
                .unwrap()
                .contains("changed since it was read")
    }));
}

#[test]
#[cfg(unix)]
fn oversized_shell_output_is_redacted_bounded_and_saved_securely() {
    let fixture = Fixture::new();
    let server = Server::new(vec![
        call(
            "large",
            "bash",
            json!({"command":"i=0; while [ \"$i\" -lt 3000 ]; do printf 'fixture-secret output line\\n'; i=$((i+1)); done"}),
        ) + &done(),
        answer("saved"),
    ]);
    let output = fixture.run(
        &server,
        &["--mode", "yolo", "--format", "jsonl", "large output"],
        "",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-secret"));
    let events = events(&output);
    let result = events
        .iter()
        .find(|event| event["type"] == "tool_finished")
        .unwrap()["output"]
        .as_str()
        .unwrap();
    assert!(result.len() <= 20 * 1024);
    assert!(result.lines().count() <= 2000);
    let artifact = result.split("Full output saved to: ").nth(1).unwrap();
    let full = fs::read_to_string(artifact).unwrap();
    assert!(full.len() > 20 * 1024);
    assert!(!full.contains("fixture-secret"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(artifact).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(std::path::Path::new(artifact).parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
#[cfg(unix)]
fn shell_state_survives_foreground_timeouts_and_sequential_read_sandboxes() {
    for sandbox in [None, Some("read")] {
        if sandbox.is_some() && !cfg!(target_os = "macos") {
            continue;
        }
        let fixture = Fixture::new();
        fs::create_dir(fixture.cwd.join("sub")).unwrap();
        let mut setup = json!({"command":"export KEPT=retained; cd sub; helper() { printf helper; }; sleep 10", "timeout":1});
        let mut verify = json!({"command":"printf '%s ' \"$KEPT\"; helper; pwd"});
        if let Some(sandbox) = sandbox {
            setup["sandbox"] = json!(sandbox);
            verify["sandbox"] = json!(sandbox);
        }
        let server = Server::new(vec![
            call("setup", "bash", setup) + &done(),
            call("verify", "bash", verify) + &done(),
            answer("verified"),
        ]);
        let output = fixture.run(
            &server,
            &["--mode", "yolo", "--format", "jsonl", "test shell state"],
            "",
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let events = events(&output);
        let setup = events
            .iter()
            .find(|event| event["type"] == "tool_finished" && event["callId"] == "setup")
            .unwrap();
        assert!(
            setup["output"]
                .as_str()
                .unwrap()
                .contains("timed out after 1s"),
            "{setup}"
        );
        let verify = events
            .iter()
            .find(|event| event["type"] == "tool_finished" && event["callId"] == "verify")
            .unwrap();
        let text = verify["output"].as_str().unwrap();
        assert!(text.contains("retained helper"), "{verify}");
        assert!(
            text.contains(fixture.cwd.join("sub").to_str().unwrap()),
            "{verify}"
        );
    }
}

#[test]
#[cfg(unix)]
fn signals_settle_the_foreground_process_tree_and_preserve_exit_codes() {
    for (signal, exit) in [("-INT", 130), ("-TERM", 143), ("-HUP", 129)] {
        let fixture = Fixture::new();
        let server = Server::new(vec![
            call(
                "sleep",
                "bash",
                json!({"command":"sleep 30 & child=$!; printf '%s %s' $$ $child > pids; wait; printf bad > late.txt"}),
            ) + &done(),
        ]);
        let mut child = fixture
            .command(
                &server,
                &["--mode", "yolo", "--format", "json", "interrupt"],
            )
            .spawn()
            .unwrap();
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !fixture.cwd.join("pids").exists() {
            assert!(Instant::now() < deadline, "shell did not start");
            assert!(child.try_wait().unwrap().is_none());
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            Command::new("/bin/kill")
                .args([signal, &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                child.kill().unwrap();
                panic!("interrupt did not settle");
            }
            thread::sleep(Duration::from_millis(5));
        }
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(json_output(&output)["status"], "interrupted");
        assert!(!fixture.cwd.join("late.txt").exists());
        for pid in fs::read_to_string(fixture.cwd.join("pids"))
            .unwrap()
            .split_whitespace()
        {
            assert!(
                !Command::new("/bin/kill")
                    .args(["-0", pid])
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success(),
                "process {pid} survived {signal}"
            );
        }
    }
}

#[test]
fn ordinary_summary_is_transactional_and_retains_authored_request() {
    for complete in [true, false] {
        let fixture = Fixture::new();
        fs::write(
            fixture.cwd.join("large.txt"),
            "old history content\n".repeat(1000),
        )
        .unwrap();
        fs::write(fixture.home.join("config.json"), json!({"contextWindows":{"openai":{"gpt-4.1":20000}},"compactionLimits":{"openai":{"gpt-4.1":4000}}}).to_string()).unwrap();
        let summary = if complete {
            answer("Read large.txt; keep working.")
        } else {
            event(json!({"type":"response.output_text.delta","delta":"unfinished summary"}))
        };
        let server = Server::new(vec![
            call("read", "read", json!({"file_path":"large.txt"})) + &done(),
            summary,
            answer("continued"),
        ]);
        let output = fixture.run(&server, &["--format", "jsonl", "authored request"], "");
        assert_eq!(
            output.status.success(),
            complete,
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let events = events(&output);
        assert_eq!(
            events.iter().any(|event| event["type"] == "compacted"),
            complete
        );
        let requests = server.requests();
        assert!(requests[1].get("tools").is_none());
        assert!(
            requests[1]["instructions"]
                .as_str()
                .unwrap()
                .contains("summarize")
        );
        let journal = fs::read_to_string(&fixture.journals()[0]).unwrap();
        assert_eq!(
            journal
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .any(|record| record["item"]["type"] == "compaction"),
            complete
        );
        if complete {
            assert_eq!(
                requests[2]["input"][0]["content"][0]["text"],
                "authored request"
            );
            assert!(
                requests[2]["input"][1]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("authoritative state summary")
            );
        }
    }
}

#[test]
#[cfg(unix)]
fn nonregular_file_tools_fail_promptly_without_blocking_runtime_exit() {
    let fixture = Fixture::new();
    assert!(
        Command::new("mkfifo")
            .arg(fixture.cwd.join("pipe"))
            .status()
            .unwrap()
            .success()
    );
    let server = Server::new(vec![
        call("read", "read", json!({"file_path":"pipe"}))
            + &call(
                "edit",
                "edit",
                json!({"file_path":"pipe","old_string":"old","new_string":"new"}),
            )
            + &call(
                "write",
                "write",
                json!({"file_path":"pipe","content":"new"}),
            )
            + &done(),
        answer("safe refusal"),
    ]);
    let started = Instant::now();
    let output = fixture.run(&server, &["--format", "jsonl", "read the pipe"], "");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        events(&output)
            .iter()
            .filter(|event| event["type"] == "tool_finished"
                && event["output"].as_str().unwrap().contains("Tool failed"))
            .count(),
        3
    );
}

#[test]
fn repeated_tool_loop_is_steered_then_stopped() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("sample.txt"), "same").unwrap();
    let server = Server::new(
        (0..4)
            .map(|index| {
                call(
                    &format!("repeat{index}"),
                    "read",
                    json!({"file_path":"sample.txt"}),
                ) + &done()
            })
            .collect(),
    );
    let output = fixture.run(&server, &["--format", "jsonl", "loop"], "");
    assert_eq!(output.status.code(), Some(1));
    let events = events(&output);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "tool_started")
            .count(),
        2
    );
    assert!(events.iter().any(|event| {
        event["type"] == "turn_failed"
            && event["message"]
                .as_str()
                .unwrap()
                .contains("repeated tool loop")
    }));
}

#[test]
fn protocol_discriminants_are_not_redacted_and_changed_replay_is_discarded() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        json!({"redaction":{"values":["type","text_delta"]}}).to_string(),
    )
    .unwrap();
    let server = Server::new(vec![answer("type fixture-secret")]);
    let output = fixture.run(&server, &["--format", "jsonl", "type"], "");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let events = events(&output);
    assert!(events.iter().any(|event| event["type"] == "text_delta"));
    let journal = fs::read_to_string(&fixture.journals()[0]).unwrap();
    let message = journal
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|record| record["item"]["type"] == "assistant_message")
        .unwrap();
    assert!(message["item"].get("replay").is_none());
}

#[test]
fn command_and_skill_expansion_keep_authored_text_and_redact_startup_warnings() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.home.join("commands")).unwrap();
    fs::create_dir_all(fixture.home.join("skills/example")).unwrap();
    fs::create_dir_all(fixture.home.join("skills/fixture-secret")).unwrap();
    fs::write(
        fixture.home.join("commands/inspect.md"),
        "Inspect the selected $1 carefully.",
    )
    .unwrap();
    fs::write(
        fixture.home.join("skills/example/SKILL.md"),
        "---\ndescription: Fixture skill\n---\nFollow the fixture procedure.",
    )
    .unwrap();
    fs::write(
        fixture.home.join("skills/fixture-secret/SKILL.md"),
        "Missing frontmatter",
    )
    .unwrap();
    for (prompt, expanded, unchanged) in [
        (
            "/inspect module",
            "Inspect the selected module carefully.",
            false,
        ),
        (
            "$example extra input",
            "Follow the fixture procedure.",
            false,
        ),
        ("Read inline $example", "Read inline $example", true),
    ] {
        let server = Server::new(vec![answer("prepared")]);
        let output = fixture.run(&server, &["--format", "jsonl", prompt], "");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            events(&output)
                .iter()
                .any(|event| event["type"] == "user_message" && event["text"] == prompt)
        );
        let request = &server.requests()[0];
        let sent = request["input"].to_string();
        assert!(sent.contains(expanded), "{sent}");
        if unchanged {
            assert!(!sent.contains("Follow the fixture procedure."));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains("fixture-secret"));
        assert!(stderr.contains("[REDACTED]"), "{stderr}");
    }
}

#[test]
fn worktree_switches_refresh_same_round_tools_structured_output_and_journal_events() {
    let fixture = Fixture::new();
    fs::write(fixture.cwd.join("sample.txt"), "tracked content\n").unwrap();
    for args in [
        vec!["init"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["add", "sample.txt"],
        vec!["commit", "-m", "fixture"],
    ] {
        let output = Command::new("git")
            .args(args)
            .current_dir(&fixture.cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let schema = fixture.root.join("schema.json");
    fs::write(&schema, json!({"type":"object","properties":{"done":{"type":"boolean"}},"required":["done"],"additionalProperties":false}).to_string()).unwrap();
    let server = Server::new(vec![
        call("enter", "worktree_enter", json!({"name":"fixture"}))
            + &call("read", "read", json!({"file_path":"sample.txt"}))
            + &call("exit", "worktree_exit", json!({"action":"remove"}))
            + &call("submit", "submit_output", json!({"done":true}))
            + &done(),
    ]);
    let output = fixture.run(
        &server,
        &[
            "--format",
            "jsonl",
            "--output-schema",
            schema.to_str().unwrap(),
            "verify worktree",
        ],
        "",
    );
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let events = events(&output);
    let changed = events
        .iter()
        .filter(|event| event["type"] == "workspace_changed")
        .collect::<Vec<_>>();
    assert_eq!(changed.len(), 2);
    assert_eq!(
        changed[0]["previous"],
        fixture.cwd.to_string_lossy().as_ref()
    );
    assert_eq!(changed[0]["cwd"], changed[1]["previous"]);
    assert_eq!(changed[1]["cwd"], fixture.cwd.to_string_lossy().as_ref());
    assert!(events.iter().any(|event| {
        event["type"] == "tool_finished"
            && event["tool"] == "read"
            && event["output"]
                .as_str()
                .unwrap()
                .contains("tracked content")
    }));
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "turn_ended" && event["output"] == json!({"done":true}))
    );
    let journal = fs::read_to_string(&fixture.journals()[0]).unwrap();
    assert_eq!(
        journal
            .lines()
            .filter(
                |line| serde_json::from_str::<Value>(line).unwrap()["event"]["type"]
                    == "workspace_changed"
            )
            .count(),
        2
    );
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("sample.txt")).unwrap(),
        "tracked content\n"
    );
}
