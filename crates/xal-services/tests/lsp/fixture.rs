use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn field<'a>(value: &'a str, name: &str) -> &'a str {
    let key = format!("\"{name}\":");
    let Some((_, value)) = value.split_once(&key) else {
        return "null";
    };
    let value = value.trim_start();
    if value.starts_with('"') {
        let mut escaped = false;
        for (index, byte) in value.bytes().enumerate().skip(1) {
            if byte == b'"' && !escaped {
                return &value[..=index];
            }
            escaped = byte == b'\\' && !escaped;
        }
    }
    value.split([',', '}', ']']).next().unwrap()
}

fn send(value: &str) {
    let mut stdout = std::io::stdout().lock();
    write!(stdout, "Content-Length: {}\r\n\r\n{value}", value.len()).unwrap();
    stdout.flush().unwrap();
}

fn log(path: &str, value: &str) {
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap(),
        "{value}"
    )
    .unwrap();
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args[1] == "child" {
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    let mode = &args[1];
    let log_path = &args[2];
    log(log_path, &format!("{{\"pid\":{}}}", std::process::id()));
    if mode == "tree" || mode == "fail-tree" {
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("child")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        log(log_path, &format!("{{\"child\":{}}}", child.id()));
        std::mem::forget(child);
    }
    #[cfg(unix)]
    if mode.starts_with("detached") {
        use std::os::unix::process::CommandExt;
        unsafe extern "C" {
            fn setsid() -> i32;
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.arg("child").stdin(Stdio::inherit());
        unsafe {
            command.pre_exec(|| {
                if setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        log(log_path, &format!("{{\"detached\":{}}}", child.id()));
        std::mem::forget(child);
    }
    if mode.ends_with("block-input") {
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut uri = "\"file:///fixture\"".to_owned();
    let mut text = "\"fixture hover\"".to_owned();
    let range = r#"{"start":{"line":0,"character":2},"end":{"line":0,"character":4}}"#;
    let mut diagnostic_count = 0;
    loop {
        let mut length = 0;
        loop {
            let mut line = String::new();
            if input.read_line(&mut line).unwrap() == 0 {
                return;
            }
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut content = vec![0; length];
        input.read_exact(&mut content).unwrap();
        let content = String::from_utf8(content).unwrap();
        log(log_path, &content);
        let method = field(&content, "method").trim_matches('"');
        let id = field(&content, "id");
        let result = match method {
            "initialize" => {
                if mode == "hang-init" {
                    continue;
                }
                if mode == "fail-tree" {
                    eprintln!("fixture initialize failure");
                    "{\"capabilities\":[]}".to_owned()
                } else if mode == "malformed" {
                    send("not json");
                    continue;
                } else if mode == "encoding" {
                    "{\"capabilities\":{\"positionEncoding\":\"utf-8\"}}".to_owned()
                } else {
                    let sync = match mode.as_str() {
                        "full" => "1",
                        "reopen" => "{\"openClose\":true,\"change\":0,\"save\":true}",
                        "save-only" => {
                            "{\"openClose\":false,\"change\":1,\"save\":{\"includeText\":true}}"
                        }
                        _ => "{\"openClose\":true,\"change\":2,\"save\":{\"includeText\":true}}",
                    };
                    let diagnostic = if mode == "pull" {
                        ",\"diagnosticProvider\":{\"identifier\":\"fixture\"}"
                    } else {
                        ""
                    };
                    format!(
                        "{{\"capabilities\":{{\"textDocumentSync\":{sync},\"positionEncoding\":\"utf-16\"{diagnostic}}}}}"
                    )
                }
            }
            "initialized" => {
                send(
                    r#"{"jsonrpc":"2.0","id":"config","method":"workspace/configuration","params":{"items":[{"section":"fixture.nested"},{}]}}"#,
                );
                send(r#"{"jsonrpc":"2.0","id":"edit","method":"workspace/applyEdit","params":{}}"#);
                continue;
            }
            "textDocument/didOpen" | "textDocument/didChange" | "textDocument/didSave" => {
                uri = field(&content, "uri").to_owned();
                if field(&content, "text") != "null" {
                    text = field(&content, "text").to_owned();
                }
                if method != "textDocument/didSave" && mode != "pull" && mode != "no-diagnostics" {
                    let version = field(&content, "version");
                    send(&format!(
                        "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/publishDiagnostics\",\"params\":{{\"uri\":{uri},\"version\":{version},\"diagnostics\":[{{\"range\":{range},\"severity\":1,\"message\":\"fixture diagnostic\"}}]}}}}"
                    ));
                }
                continue;
            }
            "textDocument/hover" => {
                if mode.ends_with("hang-query") {
                    continue;
                }
                if mode == "crash" {
                    eprintln!("fixture crashed");
                    std::process::exit(9);
                }
                if mode == "bad-result" {
                    "{\"unexpected\":true}".into()
                } else if mode == "rpc-error" {
                    send(&format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32603,\"message\":\"fixture rpc failure\"}}}}"
                    ));
                    continue;
                } else {
                    format!("{{\"contents\":{text}}}")
                }
            }
            "textDocument/definition" => {
                format!("[{{\"targetUri\":{uri},\"targetSelectionRange\":{range}}}]")
            }
            "textDocument/references" | "textDocument/implementation" => {
                format!("[{{\"uri\":{uri},\"range\":{range}}},{{\"uri\":{uri},\"range\":{range}}}]")
            }
            "textDocument/documentSymbol" => format!(
                "[{{\"name\":\"outer\",\"kind\":12,\"selectionRange\":{range},\"children\":[{{\"name\":\"inner\",\"kind\":13,\"range\":{range}}}]}}]"
            ),
            "workspace/symbol" => format!(
                "[{{\"name\":\"workspace\",\"kind\":12,\"location\":{{\"uri\":{uri},\"range\":{range}}}}}]"
            ),
            "textDocument/prepareCallHierarchy" => format!(
                "[{{\"name\":\"call\",\"kind\":12,\"uri\":{uri},\"range\":{range},\"selectionRange\":{range}}}]"
            ),
            "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls" => {
                let direction = if method == "callHierarchy/incomingCalls" {
                    "from"
                } else {
                    "to"
                };
                format!(
                    "[{{\"{direction}\":{{\"name\":\"call\",\"kind\":12,\"uri\":{uri},\"range\":{range},\"selectionRange\":{range}}}}}]"
                )
            }
            "textDocument/diagnostic" => {
                diagnostic_count += 1;
                if field(&content, "previousResultId") != "null" {
                    format!("{{\"kind\":\"unchanged\",\"resultId\":\"{diagnostic_count}\"}}")
                } else {
                    format!(
                        "{{\"kind\":\"full\",\"resultId\":\"{diagnostic_count}\",\"items\":[{{\"range\":{range},\"severity\":2,\"source\":\"fixture\",\"code\":42,\"message\":\"pull diagnostic\"}}]}}"
                    )
                }
            }
            "shutdown" => {
                if mode == "hang-shutdown" {
                    continue;
                }
                "null".into()
            }
            "exit" => return,
            _ => continue,
        };
        send(&format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}"
        ));
    }
}
