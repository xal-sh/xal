use super::*;

#[derive(Clone)]
pub struct McpManager {
    pub(super) state: Arc<Mutex<ManagerState>>,
    pub(super) operation: Arc<tokio::sync::Mutex<()>>,
}
impl McpManager {
    pub fn new(
        configs: Vec<ServerConfig>,
        app_name: String,
        app_version: String,
    ) -> io::Result<Self> {
        let mut entries = HashMap::new();
        let mut order = Vec::new();
        for config in configs {
            config.validate()?;
            let id = config.id().to_owned();
            if entries.contains_key(&id) {
                return Err(invalid(format!("duplicate MCP server: {id}")));
            }
            order.push(id.clone());
            entries.insert(
                id,
                Entry {
                    state: if config.enabled() {
                        ConnectionState::Idle
                    } else {
                        ConnectionState::Disabled
                    },
                    config,
                    calls: Vec::new(),
                    connection_transport: None,
                    service: None,
                    peer: None,
                    handler: Arc::new(HandlerState::default()),
                    tools: Vec::new(),
                    resources: Vec::new(),
                    templates: Vec::new(),
                    prompts: Vec::new(),
                    instructions: None,
                    error: None,
                    skipped_output_tools: Vec::new(),
                    seen_tool_revision: 0,
                    seen_resource_revision: 0,
                    seen_prompt_revision: 0,
                    generation: 0,
                },
            );
        }
        Ok(Self {
            state: Arc::new(Mutex::new(ManagerState {
                entries,
                order,
                closing: false,
                operation_cancel: None,
                tool_revision: 0,
                app_name,
                app_version,
            })),
            operation: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub fn servers(&self) -> Vec<ServerStatus> {
        let manager = lock(&self.state);
        manager
            .order
            .iter()
            .filter_map(|id| manager.entries.get(id))
            .map(server_status)
            .collect()
    }

    pub fn has_resources(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == ConnectionState::Connected
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "resources"))
        })
    }

    pub fn has_prompts(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == ConnectionState::Connected
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "prompts"))
        })
    }

    pub fn instructions(&self, server: &str) -> String {
        let manager = lock(&self.state);
        manager
            .entries
            .get(server)
            .filter(|entry| entry.state == ConnectionState::Connected)
            .and_then(|entry| entry.instructions.clone())
            .unwrap_or_default()
    }

    pub fn resource_catalog(&self, server: Option<&str>) -> io::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server, "resources")?
            .into_iter()
            .map(|entry| {
                json!({
                    "server": entry.config.id(),
                    "resources": entry.resources,
                    "templates": entry.templates
                })
            })
            .collect::<Vec<_>>();
        json_pretty(&Value::Array(values))
    }

    pub fn prompt_catalog(&self, server: Option<&str>) -> io::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server, "prompts")?
            .into_iter()
            .map(|entry| json!({ "server": entry.config.id(), "prompts": entry.prompts }))
            .collect::<Vec<_>>();
        json_pretty(&Value::Array(values))
    }

    pub fn tool_descriptors(&self) -> ToolSnapshot {
        tool_descriptors(&lock(&self.state))
    }

    pub fn start_tool_call(&self, request: ToolCallRequest) -> io::Result<McpCall> {
        if request.server.is_empty() {
            return Err(invalid("server is required"));
        }
        if request.name.is_empty() {
            return Err(invalid("name is required"));
        }
        let mut manager = lock(&self.state);
        let (peer, handler, duration, schema) = {
            let entry = manager
                .entries
                .get(&request.server)
                .ok_or_else(|| failed(format!("unknown MCP server: {}", request.server)))?;
            if entry.state != ConnectionState::Connected {
                return Err(failed(format!(
                    "MCP server is not connected: {}",
                    request.server
                )));
            }
            let tool = entry
                .tools
                .iter()
                .find(|tool| tool.remote.name == request.name)
                .ok_or_else(|| {
                    failed(format!(
                        "MCP tool is no longer available: {}/{}",
                        request.server, request.name
                    ))
                })?;
            crate::schema::validate(
                &Value::Object((*tool.remote.input_schema).clone()),
                &Value::Object(request.arguments.clone()),
            )?;
            (
                entry
                    .peer
                    .clone()
                    .ok_or_else(|| failed("MCP server disconnected"))?,
                entry.handler.clone(),
                entry.config.timeout(),
                tool.output_schema.clone(),
            )
        };
        let (progress_sender, progress_receiver) = mpsc::sync_channel(PROGRESS_CAPACITY);
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let shared = Arc::new(CallShared {
            progress: Mutex::new(ProgressReceiver {
                receiver: progress_receiver,
                pending: VecDeque::new(),
            }),
            result: Mutex::new(Some(result_receiver)),
            cancelled: AtomicBool::new(false),
        });
        let task_shared = shared.clone();
        let remote_name = request.name.clone();
        let server = request.server.clone();
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|error| failed(format!("MCP calls require a Tokio runtime: {error}")))?;
        let task = runtime.spawn(async move {
            let mut params = CallToolRequestParams::new(Cow::Owned(request.name));
            params.arguments = Some(request.arguments);
            let handle = cancellable(
                duration,
                "MCP tool request",
                &task_shared.cancelled,
                peer.send_cancellable_request(
                    ClientRequest::CallToolRequest(CallToolRequest::new(params)),
                    PeerRequestOptions::no_options(),
                ),
            )
            .await;
            let progress_key = handle.as_ref().ok().map(|handle| {
                serde_json::to_string(&handle.progress_token).expect("progress token serializes")
            });
            if let Some(progress_key) = &progress_key {
                lock(&handler.progress).register(progress_key.clone(), progress_sender);
            }
            let outcome = match handle {
                Ok(handle) => {
                    await_response(handle, duration, &task_shared.cancelled, "MCP tool call")
                        .await
                        .and_then(|result| match result {
                            ServerResult::CallToolResult(result) => Ok(result),
                            _ => Err(failed("MCP tool returned an unexpected response")),
                        })
                        .and_then(|result| {
                            let value = serde_json::to_value(result)
                                .map_err(|error| failed(error.to_string()))?;
                            output_validation(&remote_name, schema.as_ref(), &value)?;
                            format_tool_result(&value)
                        })
                }
                Err(error) => Err(error),
            };
            if let Some(progress_key) = progress_key {
                lock(&handler.progress).senders.remove(&progress_key);
            }
            let _ = result_sender.send(outcome);
        });
        manager
            .entries
            .get_mut(&server)
            .expect("validated MCP server exists")
            .calls
            .push(call::OwnedCall {
                shared: shared.clone(),
                task,
            });
        Ok(McpCall { shared })
    }
}
