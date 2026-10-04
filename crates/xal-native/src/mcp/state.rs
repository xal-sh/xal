use super::*;

pub(super) struct Entry {
    pub(super) config: ServerConfig,
    pub(super) state: String,
    pub(super) connection_transport: Option<String>,
    pub(super) service: Option<RunningService<RoleClient, Handler>>,
    pub(super) peer: Option<Peer<RoleClient>>,
    pub(super) handler: Arc<HandlerState>,
    pub(super) tools: Vec<ToolRecord>,
    pub(super) resources: Vec<Value>,
    pub(super) templates: Vec<Value>,
    pub(super) prompts: Vec<Value>,
    pub(super) instructions: Option<String>,
    pub(super) error: Option<String>,
    pub(super) skipped_output_tools: Vec<String>,
    pub(super) seen_tool_revision: u64,
    pub(super) seen_resource_revision: u64,
    pub(super) seen_prompt_revision: u64,
    pub(super) generation: u64,
}

pub(super) struct ManagerState {
    pub(super) entries: HashMap<String, Entry>,
    pub(super) order: Vec<String>,
    pub(super) closing: bool,
    pub(super) tool_revision: u64,
    pub(super) app_name: String,
    pub(super) app_version: String,
}
pub(super) fn tool_descriptors(manager: &ManagerState) -> Value {
    let tools = manager
        .order
        .iter()
        .filter_map(|id| manager.entries.get(id))
        .filter(|entry| entry.state == "connected")
        .flat_map(|entry| {
            entry.tools.iter().map(|tool| {
                let title = tool
                    .remote
                    .title
                    .clone()
                    .or_else(|| {
                        tool.remote
                            .annotations
                            .as_ref()
                            .and_then(|value| value.title.clone())
                    })
                    .unwrap_or_else(|| format!("{}: {}", entry.config.id(), tool.remote.name));
                json!({
                    "name": tool.native_name,
                    "server": entry.config.id(),
                    "remoteName": tool.remote.name,
                    "description": format!(
                        "MCP tool {} from server {}. {}",
                        tool.remote.name,
                        entry.config.id(),
                        tool.remote.description.as_deref().unwrap_or("No server description.")
                    ),
                    "parameters": Value::Object((*tool.remote.input_schema).clone()),
                    "title": title
                })
            })
        })
        .collect::<Vec<_>>();
    json!({ "revision": manager.tool_revision, "tools": tools })
}

pub(super) fn server_status(entry: &Entry) -> Value {
    let mut warnings = Vec::new();
    if !entry.skipped_output_tools.is_empty() {
        warnings.push(format!(
            "output schemas skipped: {}",
            entry.skipped_output_tools.join("; ")
        ));
    }
    if let Some(error) = &entry.error {
        warnings.push(error.clone());
    }
    let mut status = json!({
        "id": entry.config.id(),
        "configuredTransport": entry.config.transport(),
        "state": entry.state,
        "tools": entry.tools.len(),
        "resources": entry.resources.len(),
        "resourceTemplates": entry.templates.len(),
        "prompts": entry.prompts.len()
    });
    let object = status.as_object_mut().expect("status is an object");
    if let Some(transport) = &entry.connection_transport {
        object.insert(
            "connectionTransport".to_owned(),
            Value::String(transport.clone()),
        );
    }
    if !warnings.is_empty() {
        object.insert("warning".to_owned(), Value::String(warnings.join("; ")));
    }
    status
}
pub(super) fn connected_entries<'a>(
    manager: &'a ManagerState,
    server: Option<&str>,
    capability: &str,
) -> napi::Result<Vec<&'a Entry>> {
    if let Some(server) = server {
        let entry = manager
            .entries
            .get(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        if entry.state != "connected" {
            return Err(failed(format!("MCP server is not connected: {server}")));
        }
        let peer = entry
            .peer
            .as_ref()
            .ok_or_else(|| failed(format!("MCP server is not connected: {server}")))?;
        if !has_capability(peer, capability) {
            return Err(failed(format!(
                "MCP server does not provide {capability}: {server}"
            )));
        }
        return Ok(vec![entry]);
    }
    Ok(manager
        .order
        .iter()
        .filter_map(|id| manager.entries.get(id))
        .filter(|entry| {
            entry.state == "connected"
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, capability))
        })
        .collect())
}
