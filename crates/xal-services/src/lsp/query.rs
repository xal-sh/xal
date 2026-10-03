use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Definition,
    References,
    Hover,
    DocumentSymbols,
    WorkspaceSymbols,
    Implementation,
    IncomingCalls,
    OutgoingCalls,
    Diagnostics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub operation: Operation,
    #[serde(alias = "file_path")]
    pub file_path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub query: Option<String>,
}

impl Query {
    pub fn validate(&self) -> std::io::Result<()> {
        if self.file_path.is_empty() {
            return Err(invalid("file_path is required"));
        }
        match self.operation {
            Operation::Definition
            | Operation::References
            | Operation::Hover
            | Operation::Implementation
            | Operation::IncomingCalls
            | Operation::OutgoingCalls => {
                if self.line.is_none_or(|line| line == 0)
                    || self.column.is_none_or(|column| column == 0)
                {
                    return Err(invalid(
                        "position-based LSP queries require positive line and column",
                    ));
                }
            }
            Operation::WorkspaceSymbols => {
                if self
                    .query
                    .as_ref()
                    .is_none_or(|query| query.trim().is_empty())
                {
                    return Err(invalid("query is required for workspace_symbols"));
                }
            }
            Operation::DocumentSymbols | Operation::Diagnostics => {}
        }
        Ok(())
    }
}

pub(super) fn query_client(
    client: &mut RpcClient,
    language_id: &str,
    path: &Path,
    query: &Query,
    cwd: &str,
    cancelled_flag: &dyn Fn() -> bool,
) -> std::io::Result<String> {
    let (uri, version, changed) = client.sync_document(path, language_id, cancelled_flag)?;
    if changed && query.operation != Operation::Diagnostics {
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
    match query.operation {
        Operation::Definition => format_locations(
            &client.request("textDocument/definition", position(), cancelled_flag)?,
            cwd,
            "definition",
            "definitions",
        ),
        Operation::References => format_locations(
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
        Operation::Hover => {
            format_hover(&client.request("textDocument/hover", position(), cancelled_flag)?)
        }
        Operation::DocumentSymbols => format_symbols(
            &client.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                cancelled_flag,
            )?,
            cwd,
            &uri,
        ),
        Operation::WorkspaceSymbols => format_symbols(
            &client.request(
                "workspace/symbol",
                json!({ "query": query.query.as_deref().unwrap_or("").trim() }),
                cancelled_flag,
            )?,
            cwd,
            &uri,
        ),
        Operation::Implementation => format_locations(
            &client.request("textDocument/implementation", position(), cancelled_flag)?,
            cwd,
            "implementation",
            "implementations",
        ),
        Operation::IncomingCalls | Operation::OutgoingCalls => {
            let prepared = client.request(
                "textDocument/prepareCallHierarchy",
                position(),
                cancelled_flag,
            )?;
            let item = first_item(&prepared);
            let direction = if query.operation == Operation::IncomingCalls {
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
        Operation::Diagnostics => {
            if client
                .capabilities
                .get("diagnosticProvider")
                .is_some_and(|value| value == true || value.is_object())
            {
                let mut params = json!({ "textDocument": { "uri": uri } });
                if let Some((id, _)) = client.pull_diagnostics.get(path) {
                    params["previousResultId"] = json!(id);
                }
                if let Some(identifier) = client.capabilities["diagnosticProvider"]
                    .get("identifier")
                    .and_then(Value::as_str)
                {
                    params["identifier"] = json!(identifier);
                }
                let result = client.request("textDocument/diagnostic", params, cancelled_flag)?;
                let items = match result.get("kind").and_then(Value::as_str) {
                    Some("full") => result.get("items").and_then(Value::as_array).cloned(),
                    Some("unchanged") => client
                        .pull_diagnostics
                        .get(path)
                        .map(|(_, items)| items.clone()),
                    _ => None,
                }
                .ok_or_else(|| failed("language server returned malformed pull diagnostics"))?;
                let output = format_diagnostics(&items, &uri, cwd)?;
                if let Some(id) = result.get("resultId").and_then(Value::as_str) {
                    client
                        .pull_diagnostics
                        .insert(path.to_path_buf(), (id.into(), items));
                } else {
                    client.pull_diagnostics.remove(path);
                }
                return Ok(output);
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
                .get(&uri)
                .map(|(_, items)| items.as_slice())
                .unwrap_or_default();
            format_diagnostics(items, &uri, cwd)
        }
    }
}
