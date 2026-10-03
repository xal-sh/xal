use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Disabled,
    Idle,
    Connecting,
    Connected,
    Failed,
}

impl ConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Idle => "idle",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionTransport {
    Stdio,
    Http,
    Sse,
}

impl ConnectionTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Http => "http",
            Self::Sse => "sse",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub server: String,
    pub remote_name: String,
    pub description: String,
    pub parameters: Map<String, Value>,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolSnapshot {
    pub revision: u64,
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    pub configured_transport: ConnectionTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_transport: Option<ConnectionTransport>,
    pub state: ConnectionState,
    pub tools: usize,
    pub resources: usize,
    pub resource_templates: usize,
    pub prompts: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl ServerStatus {
    pub fn line(&self) -> String {
        let id = &self.id;
        match self.state {
            ConnectionState::Connected => format!(
                "{id} · connected ({}) · {} tools · {} resources · {} templates · {} prompts{}",
                self.connection_transport
                    .unwrap_or(self.configured_transport)
                    .as_str(),
                self.tools,
                self.resources,
                self.resource_templates,
                self.prompts,
                self.warning
                    .as_ref()
                    .map(|warning| format!(" · warning: {warning}"))
                    .unwrap_or_default()
            ),
            ConnectionState::Failed => format!(
                "{id} · failed · {}",
                self.warning.as_deref().unwrap_or("unknown error")
            ),
            state => format!("{id} · {}", state.as_str()),
        }
    }
}

pub(super) struct Entry {
    pub(super) config: ServerConfig,
    pub(super) calls: Vec<call::OwnedCall>,
    pub(super) state: ConnectionState,
    pub(super) connection_transport: Option<ConnectionTransport>,
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

impl Entry {
    pub(super) fn clear_catalogs(&mut self) {
        self.peer = None;
        self.connection_transport = None;
        self.tools.clear();
        self.resources.clear();
        self.templates.clear();
        self.prompts.clear();
        self.skipped_output_tools.clear();
        self.instructions = None;
    }
}

pub(super) struct ManagerState {
    pub(super) entries: HashMap<String, Entry>,
    pub(super) order: Vec<String>,
    pub(super) closing: bool,
    pub(super) operation_cancel: Option<Arc<AtomicBool>>,
    pub(super) tool_revision: u64,
    pub(super) app_name: String,
    pub(super) app_version: String,
}

pub(super) fn tool_descriptors(manager: &ManagerState) -> ToolSnapshot {
    let tools = manager
        .order
        .iter()
        .filter_map(|id| manager.entries.get(id))
        .filter(|entry| entry.state == ConnectionState::Connected)
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
                ToolDescriptor {
                    name: tool.native_name.clone(),
                    server: entry.config.id().into(),
                    remote_name: tool.remote.name.to_string(),
                    description: format!(
                        "MCP tool {} from server {}. {}",
                        tool.remote.name,
                        entry.config.id(),
                        tool.remote
                            .description
                            .as_deref()
                            .unwrap_or("No server description.")
                    ),
                    parameters: (*tool.remote.input_schema).clone(),
                    title,
                }
            })
        })
        .collect();
    ToolSnapshot {
        revision: manager.tool_revision,
        tools,
    }
}

pub(super) fn server_status(entry: &Entry) -> ServerStatus {
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
    ServerStatus {
        id: entry.config.id().into(),
        configured_transport: entry.config.transport(),
        connection_transport: entry.connection_transport,
        state: entry.state,
        tools: entry.tools.len(),
        resources: entry.resources.len(),
        resource_templates: entry.templates.len(),
        prompts: entry.prompts.len(),
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    }
}

pub(super) fn connected_entries<'a>(
    manager: &'a ManagerState,
    server: Option<&str>,
    capability: &str,
) -> io::Result<Vec<&'a Entry>> {
    if let Some(server) = server {
        let entry = manager
            .entries
            .get(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        if entry.state != ConnectionState::Connected {
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
            entry.state == ConnectionState::Connected
                && entry
                    .peer
                    .as_ref()
                    .is_some_and(|peer| has_capability(peer, capability))
        })
        .collect())
}
