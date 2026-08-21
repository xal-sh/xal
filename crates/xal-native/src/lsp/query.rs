use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Query {
    operation: String,
    file_path: String,
    line: Option<u32>,
    column: Option<u32>,
    query: Option<String>,
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

pub(super) fn manager_query(
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

#[cfg(test)]
mod tests {
    use super::parse_query;

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
}
