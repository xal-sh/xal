use super::*;

#[napi]
pub struct NativeMcpManager {
    state: Arc<Mutex<ManagerState>>,
    runtime: Arc<Runtime>,
}
#[napi]
impl NativeMcpManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(configs: String, app_name: String, app_version: String) -> napi::Result<Self> {
        let configs: Vec<ServerConfig> = serde_json::from_str(&configs)
            .map_err(|error| invalid(format!("invalid native MCP configuration: {error}")))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| failed(error.to_string()))?;
        let mut entries = HashMap::new();
        let mut order = Vec::new();
        for config in configs {
            let id = config.id().to_owned();
            if entries.contains_key(&id) {
                return Err(invalid(format!("duplicate MCP server: {id}")));
            }
            order.push(id.clone());
            entries.insert(
                id,
                Entry {
                    state: if config.enabled() { "idle" } else { "disabled" }.to_owned(),
                    config,
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
                tool_revision: 0,
                app_name,
                app_version,
            })),
            runtime: Arc::new(runtime),
        })
    }

    fn task(
        &self,
        operation: ManagerOperation,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        AsyncTask::new(ManagerTask {
            state: self.state.clone(),
            runtime: self.runtime.clone(),
            operation,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn connect_all(&self, signal: Option<AbortSignal>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ConnectAll, signal)
    }

    #[napi(catch_unwind)]
    pub fn reconnect(&self, server: Option<String>) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Reconnect(server), None)
    }

    #[napi(catch_unwind)]
    pub fn remove(&self, server: String) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Remove(server), None)
    }

    #[napi(catch_unwind)]
    pub fn refresh(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Refresh, None)
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::Close, None)
    }

    #[napi(catch_unwind)]
    pub fn servers(&self) -> napi::Result<String> {
        let manager = lock(&self.state);
        serde_json::to_string(
            &manager
                .order
                .iter()
                .filter_map(|id| manager.entries.get(id))
                .map(server_status)
                .collect::<Vec<_>>(),
        )
        .map_err(|error| failed(error.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, server: Option<String>) -> Vec<String> {
        let manager = lock(&self.state);
        let statuses = manager
            .order
            .iter()
            .filter(|id| server.as_ref().is_none_or(|server| *id == server))
            .filter_map(|id| manager.entries.get(id))
            .map(server_status)
            .collect::<Vec<_>>();
        if statuses.is_empty() {
            return vec!["No MCP servers configured.".to_owned()];
        }
        statuses
            .iter()
            .map(|status| {
                let id = status["id"].as_str().unwrap_or("MCP");
                let state = status["state"].as_str().unwrap_or("failed");
                let warning = status.get("warning").and_then(Value::as_str);
                if state == "connected" {
                    return format!(
                        "{id} · connected ({}) · {} tools · {} resources · {} templates · {} prompts{}",
                        status["connectionTransport"].as_str().unwrap_or("unknown"),
                        status["tools"].as_u64().unwrap_or(0),
                        status["resources"].as_u64().unwrap_or(0),
                        status["resourceTemplates"].as_u64().unwrap_or(0),
                        status["prompts"].as_u64().unwrap_or(0),
                        warning.map(|warning| format!(" · warning: {warning}")).unwrap_or_default()
                    );
                }
                if state == "failed" {
                    return format!("{id} · failed · {}", warning.unwrap_or("unknown error"));
                }
                format!("{id} · {state}")
            })
            .collect()
    }

    #[napi(getter, catch_unwind)]
    pub fn has_resources(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "resources"))
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn has_prompts(&self) -> bool {
        lock(&self.state).entries.values().any(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, "prompts"))
        })
    }

    #[napi(catch_unwind)]
    pub fn instructions(&self, server: String) -> String {
        let manager = lock(&self.state);
        manager
            .entries
            .get(&server)
            .filter(|entry| entry.state == "connected")
            .and_then(|entry| entry.instructions.clone())
            .unwrap_or_default()
    }

    #[napi(catch_unwind)]
    pub fn resource_catalog(&self, server: Option<String>) -> napi::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server.as_deref(), "resources")?
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

    #[napi(catch_unwind)]
    pub fn prompt_catalog(&self, server: Option<String>) -> napi::Result<String> {
        let manager = lock(&self.state);
        let values = connected_entries(&manager, server.as_deref(), "prompts")?
            .into_iter()
            .map(|entry| json!({ "server": entry.config.id(), "prompts": entry.prompts }))
            .collect::<Vec<_>>();
        json_pretty(&Value::Array(values))
    }

    #[napi(catch_unwind)]
    pub fn read_resource(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::ReadResource(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn get_prompt(
        &self,
        request: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<ManagerTask> {
        self.task(ManagerOperation::GetPrompt(request), signal)
    }

    #[napi(catch_unwind)]
    pub fn tool_descriptors(&self) -> napi::Result<String> {
        serde_json::to_string(&tool_descriptors(&lock(&self.state)))
            .map_err(|error| failed(error.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn start_tool_call(&self, request: String) -> napi::Result<NativeMcpCall> {
        let request: ToolCallRequest = serde_json::from_str(&request)
            .map_err(|error| invalid(format!("invalid MCP tool request: {error}")))?;
        if request.server.is_empty() {
            return Err(invalid("server is required"));
        }
        if request.name.is_empty() {
            return Err(invalid("name is required"));
        }
        let (peer, handler, duration, schema) = {
            let manager = lock(&self.state);
            let entry = manager
                .entries
                .get(&request.server)
                .ok_or_else(|| failed(format!("unknown MCP server: {}", request.server)))?;
            if entry.state != "connected" {
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
        self.runtime.spawn(async move {
            let mut params = CallToolRequestParams::new(Cow::Owned(request.name));
            params.arguments = Some(request.arguments);
            let handle = peer
                .send_cancellable_request(
                    ClientRequest::CallToolRequest(CallToolRequest::new(params)),
                    PeerRequestOptions::no_options(),
                )
                .await;
            let progress_key = handle
                .as_ref()
                .ok()
                .and_then(|handle| serde_json::to_string(&handle.progress_token).ok());
            if let Some(progress_key) = &progress_key {
                lock(&handler.progress).insert(progress_key.clone(), progress_sender);
            }
            let outcome = match handle {
                Ok(handle) => await_tool_response(handle, duration, &task_shared.cancelled)
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
                    }),
                Err(error) => Err(failed(error.to_string())),
            }
            .map_err(|error| error.to_string());
            if let Some(progress_key) = progress_key {
                lock(&handler.progress).remove(&progress_key);
            }
            let _ = result_sender.send(outcome);
        });
        Ok(NativeMcpCall { shared })
    }
}
