use super::*;

#[derive(Deserialize)]
struct ResourceRequest {
    server: String,
    uri: String,
}

#[derive(Deserialize)]
struct PromptRequest {
    server: String,
    name: String,
    arguments: Option<Map<String, Value>>,
}

pub struct ManagerTask {
    pub(super) state: Arc<Mutex<ManagerState>>,
    pub(super) runtime: Arc<Runtime>,
    pub(super) operation: ManagerOperation,
    pub(super) cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(super) enum ManagerOperation {
    ConnectAll,
    Reconnect(Option<String>),
    Remove(String),
    Refresh,
    Close,
    ReadResource(String),
    GetPrompt(String),
}

impl Task for ManagerTask {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let state = self.state.clone();
        let cancelled = self.cancelled.clone();
        let operation = self.operation.clone();
        self.runtime.block_on(async move {
            match &operation {
                ManagerOperation::ConnectAll => {
                    let ids = {
                        let manager = lock(&state);
                        manager
                            .order
                            .iter()
                            .filter(|id| {
                                manager
                                    .entries
                                    .get(*id)
                                    .is_some_and(|entry| entry.config.enabled())
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    };
                    for id in ids {
                        if cancelled.load(Ordering::Relaxed) {
                            break;
                        }
                        connect_entry(state.clone(), id, cancelled.clone()).await?;
                    }
                    if cancelled.load(Ordering::Relaxed) {
                        close_all(state.clone()).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Reconnect(server) => {
                    let ids = if let Some(server) = server {
                        vec![server.clone()]
                    } else {
                        let manager = lock(&state);
                        manager
                            .order
                            .iter()
                            .filter(|id| {
                                manager
                                    .entries
                                    .get(*id)
                                    .is_some_and(|entry| entry.config.enabled())
                            })
                            .cloned()
                            .collect()
                    };
                    for id in ids {
                        connect_entry(state.clone(), id, cancelled.clone()).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Remove(server) => {
                    remove_entry(state.clone(), server).await?;
                    Ok(None)
                }
                ManagerOperation::Refresh => {
                    let ids = lock(&state).order.clone();
                    for id in ids {
                        refresh_entry(state.clone(), id).await?;
                    }
                    Ok(None)
                }
                ManagerOperation::Close => {
                    close_all(state.clone()).await?;
                    Ok(None)
                }
                ManagerOperation::ReadResource(request) => {
                    let request: ResourceRequest =
                        serde_json::from_str(request).map_err(|error| {
                            invalid(format!("invalid MCP resource request: {error}"))
                        })?;
                    if request.server.is_empty() {
                        return Err(invalid("server is required"));
                    }
                    if request.uri.is_empty() {
                        return Err(invalid("uri is required"));
                    }
                    let (peer, duration) = connected_peer(&state, &request.server, "resources")?;
                    let result = cancellable(
                        duration,
                        "MCP resource read",
                        &cancelled,
                        peer.read_resource(ReadResourceRequestParams::new(request.uri)),
                    )
                    .await?;
                    let value =
                        serde_json::to_value(result).map_err(|error| failed(error.to_string()))?;
                    let mut sections = value
                        .get("contents")
                        .and_then(Value::as_array)
                        .ok_or_else(|| failed("MCP resource result is malformed"))?
                        .iter()
                        .map(format_resource)
                        .collect::<napi::Result<Vec<_>>>()?;
                    sections.retain(|section| !section.is_empty());
                    Ok(Some(if sections.is_empty() {
                        "(empty MCP resource)".to_owned()
                    } else {
                        sections.join("\n\n")
                    }))
                }
                ManagerOperation::GetPrompt(request) => {
                    let request: PromptRequest = serde_json::from_str(request)
                        .map_err(|error| invalid(format!("invalid MCP prompt request: {error}")))?;
                    if request.server.is_empty() {
                        return Err(invalid("server is required"));
                    }
                    if request.name.is_empty() {
                        return Err(invalid("name is required"));
                    }
                    let (peer, duration) = connected_peer(&state, &request.server, "prompts")?;
                    let result = cancellable(
                        duration,
                        "MCP prompt request",
                        &cancelled,
                        peer.get_prompt({
                            let mut params = rmcp::model::GetPromptRequestParams::new(request.name);
                            params.arguments = request.arguments;
                            params
                        }),
                    )
                    .await?;
                    let value =
                        serde_json::to_value(result).map_err(|error| failed(error.to_string()))?;
                    Ok(Some(format_prompt(&value)?))
                }
            }
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}
