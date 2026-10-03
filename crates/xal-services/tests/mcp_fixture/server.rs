use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let (_, value) = line.split_once(&format!("\"{name}\":"))?;
    if let Some(value) = value.strip_prefix('"') {
        return value.split('"').next();
    }
    value.split([',', '}']).next()
}

fn send(output: &Mutex<io::Stdout>, value: &str) {
    let mut output = output.lock().unwrap();
    writeln!(output, "{value}").unwrap();
    output.flush().unwrap();
}

fn result(output: &Mutex<io::Stdout>, id: &str, value: &str) {
    send(
        output,
        &format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{value}}}"),
    );
}

fn main() {
    if std::env::args().any(|arg| arg == "descendant") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if let Ok(path) = std::env::var("MCP_PID_PATH") {
        std::fs::write(path, std::process::id().to_string()).unwrap();
    }
    if let Ok(path) = std::env::var("MCP_CHILD_PATH") {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("descendant")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write(path, child.id().to_string()).unwrap();
    }
    let mode = std::env::var("MCP_MODE").unwrap_or_default();
    let flush_path = if mode == "flush" {
        Some(
            std::path::PathBuf::from(std::env::var("MCP_PID_PATH").unwrap())
                .with_extension("flush"),
        )
    } else {
        None
    };
    if let Some(path) = &flush_path {
        std::fs::write(path.with_extension("lock"), "locked").unwrap();
    }
    let output = Arc::new(Mutex::new(io::stdout()));
    let mut version = false;
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let method = field(&line, "method").unwrap_or("");
        if method == "notifications/cancelled" {
            if let Ok(path) = std::env::var("MCP_CANCEL_PATH") {
                std::fs::write(path, "cancelled").unwrap();
            }
            continue;
        }
        let Some(id) = field(&line, "id") else {
            continue;
        };
        match method {
            "initialize" => {
                if mode == "hang"
                    || (mode == "retry" && !std::path::Path::new("retry.ready").exists())
                {
                    eprintln!("fixture waiting for cancellation");
                    continue;
                }
                assert!(!line.contains("\"tasks\""));
                result(
                    &output,
                    id,
                    &format!(
                        "{{\"protocolVersion\":\"{}\",\"capabilities\":{{\"tools\":{{\"listChanged\":true}},\"resources\":{{\"listChanged\":true}},\"prompts\":{{\"listChanged\":true}}}},\"serverInfo\":{{\"name\":\"fixture\",\"version\":\"1\"}},\"instructions\":\"Use fixture tools.\"}}",
                        field(&line, "protocolVersion").unwrap()
                    ),
                );
            }
            "tools/list" => {
                let tools = if version {
                    r#"{"tools":[{"name":"added","description":"Added dynamically","inputSchema":{"type":"object","additionalProperties":false}}]}"#.to_owned()
                } else {
                    format!(
                        r#"{{"tools":[{{"name":"echo tool","description":"Echo a value","inputSchema":{{"type":"object","properties":{{"value":{{"type":"string"}}}},"required":["value"],"additionalProperties":false}},"outputSchema":{{"type":"object","properties":{{"echoed":{{"type":"string"}}}},"required":["echoed"],"additionalProperties":false}},"annotations":{{"readOnlyHint":true}}}},{{"name":"slow","inputSchema":{{"type":"object"}}}},{{"name":"task only","inputSchema":{{"type":"object"}},"execution":{{"taskSupport":"required"}}}},{{"name":"unsupported","inputSchema":{{"type":"object"}},"outputSchema":{{"$schema":"https://invalid.test/dialect"}}}}]{} }}"#,
                        if mode == "cursor" {
                            r#", "nextCursor":"same""#
                        } else {
                            ""
                        }
                    )
                };
                result(&output, id, &tools);
            }
            "resources/list" => {
                let value = if field(&line, "cursor").is_none() {
                    r#"{"resources":[{"uri":"fixture://one","name":"One"}],"nextCursor":"next"}"#
                } else {
                    r#"{"resources":[{"uri":"fixture://two","name":"Two"}]}"#
                };
                result(&output, id, value);
            }
            "resources/templates/list" => result(
                &output,
                id,
                r#"{"resourceTemplates":[{"uriTemplate":"fixture://{name}","name":"Fixture"}]}"#,
            ),
            "prompts/list" => result(
                &output,
                id,
                r#"{"prompts":[{"name":"hello","arguments":[{"name":"name","required":false}]}]}"#,
            ),
            "resources/read" => {
                if field(&line, "uri") == Some("fixture://slow") {
                    continue;
                }
                result(
                    &output,
                    id,
                    &format!(
                        r#"{{"contents":[{{"uri":"{}","text":"resource text"}},{{"uri":"fixture://binary","mimeType":"image/png","blob":"aGk="}}]}}"#,
                        field(&line, "uri").unwrap()
                    ),
                );
            }
            "prompts/get" => {
                if line.contains("\"name\":\"slow\"") {
                    continue;
                }
                result(
                    &output,
                    id,
                    r#"{"description":"Greeting","messages":[{"role":"user","content":{"type":"text","text":"Hello Ada"}}]}"#,
                );
            }
            "tools/call" => {
                if field(&line, "name") == Some("slow") {
                    continue;
                }
                if field(&line, "name") == Some("task only") {
                    send(
                        &output,
                        &format!(
                            r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32601,"message":"Tasks support required"}}}}"#
                        ),
                    );
                    continue;
                }
                if field(&line, "name") == Some("added") {
                    result(
                        &output,
                        id,
                        r#"{"content":[{"type":"text","text":"added"}]}"#,
                    );
                    continue;
                }
                version = true;
                let output = output.clone();
                let id = id.to_owned();
                let value = field(&line, "value").unwrap().to_owned();
                let token = field(&line, "progressToken").unwrap_or("0").to_owned();
                std::thread::spawn(move || {
                    for index in 1..=4 {
                        send(
                            &output,
                            &format!(
                                r#"{{"jsonrpc":"2.0","method":"notifications/progress","params":{{"progressToken":{token},"progress":{index},"total":4}}}}"#
                            ),
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if value == "invalid" {
                        result(
                            &output,
                            &id,
                            r#"{"content":[],"structuredContent":{"echoed":2}}"#,
                        );
                        return;
                    }
                    result(
                        &output,
                        &id,
                        &format!(
                            r#"{{"content":[{{"type":"text","text":"echo complete"}},{{"type":"image","mimeType":"image/png","data":"aGk="}},{{"type":"audio","mimeType":"audio/wav","data":"aGk="}}],"structuredContent":{{"echoed":"{value}"}}}}"#
                        ),
                    );
                    send(
                        &output,
                        r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#,
                    );
                    send(
                        &output,
                        r#"{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}"#,
                    );
                    send(
                        &output,
                        r#"{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}"#,
                    );
                });
            }
            _ => send(
                &output,
                &format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32601,"message":"not found"}}}}"#
                ),
            ),
        }
    }
    if mode == "unresponsive" {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if let Some(path) = flush_path {
        let mut file = io::BufWriter::new(std::fs::File::create(&path).unwrap());
        file.write_all(b"flushed").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        output
            .lock()
            .unwrap()
            .write_all(&vec![b'\n'; 256 * 1024])
            .unwrap();
        file.flush().unwrap();
        std::fs::remove_file(path.with_extension("lock")).unwrap();
    }
}
