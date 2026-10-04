use super::*;

pub(super) struct ManagerState {
    pub(super) definitions: Vec<ServerDefinition>,
    pub(super) clients: HashMap<String, Arc<Mutex<RpcClient>>>,
    pub(super) failures: HashMap<String, (String, PathBuf, String)>,
    pub(super) closing: bool,
    pub(super) app_name: String,
    pub(super) app_version: String,
}

#[napi]
pub struct NativeLspManager {
    state: Arc<Mutex<ManagerState>>,
}
pub struct QueryTask {
    state: Arc<Mutex<ManagerState>>,
    request: String,
    cwd: String,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

impl Task for QueryTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        manager_query(&self.state, &self.request, &self.cwd, &self.cancelled)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct ActionTask {
    state: Arc<Mutex<ManagerState>>,
    action: Action,
}

enum Action {
    Restart(Option<String>),
    Close,
}

impl Task for ActionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let clients = {
            let mut manager = lock(&self.state);
            match &self.action {
                Action::Restart(server) => {
                    if manager.closing {
                        return Err(failed("language server manager is shutting down"));
                    }
                    if let Some(server) = server {
                        let definition =
                            manager
                                .definitions
                                .iter()
                                .find(|definition| match definition {
                                    ServerDefinition::Enabled { server: config } => {
                                        config.id == *server
                                    }
                                    ServerDefinition::Disabled { id } => id == server,
                                });
                        match definition {
                            None => {
                                return Err(failed(format!("unknown language server: {server}")));
                            }
                            Some(ServerDefinition::Disabled { .. }) => {
                                return Err(failed(format!(
                                    "language server is disabled: {server}"
                                )));
                            }
                            Some(ServerDefinition::Enabled { .. }) => {}
                        }
                    }
                    manager
                        .failures
                        .retain(|_, (id, _, _)| server.as_ref().is_some_and(|server| id != server));
                    let keys = manager
                        .clients
                        .iter()
                        .filter(|(_, client)| {
                            server
                                .as_ref()
                                .is_none_or(|server| lock(client).id == *server)
                        })
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    keys.into_iter()
                        .filter_map(|key| manager.clients.remove(&key))
                        .collect::<Vec<_>>()
                }
                Action::Close => {
                    manager.closing = true;
                    manager.failures.clear();
                    manager.clients.drain().map(|(_, client)| client).collect()
                }
            }
        };
        let mut failures = Vec::new();
        for client in clients {
            let client = Arc::try_unwrap(client)
                .map_err(|_| failed("language server is still in use during shutdown"))?
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Err(error) = client.close() {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            return Ok(());
        }
        let operation = match self.action {
            Action::Restart(_) => "restart",
            Action::Close => "shutdown",
        };
        Err(failed(format!(
            "language server {operation} failed: {}",
            failures.join("; ")
        )))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
impl NativeLspManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(definitions: String, app_name: String, app_version: String) -> napi::Result<Self> {
        let definitions = serde_json::from_str(&definitions)
            .map_err(|error| invalid(format!("invalid native LSP configuration: {error}")))?;
        Ok(Self {
            state: Arc::new(Mutex::new(ManagerState {
                definitions,
                clients: HashMap::new(),
                failures: HashMap::new(),
                closing: false,
                app_name,
                app_version,
            })),
        })
    }

    #[napi(catch_unwind)]
    pub fn has_available_server(&self, cwd: String) -> bool {
        let manager = lock(&self.state);
        if !manager.clients.is_empty() {
            return true;
        }
        manager.definitions.iter().any(|definition| {
            let ServerDefinition::Enabled { server } = definition else {
                return false;
            };
            executable(server, Path::new(&cwd)).is_some() || may_resolve_from_another_root(server)
        })
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, cwd: String) -> Vec<String> {
        let manager = lock(&self.state);
        if manager.definitions.is_empty() {
            return vec!["No language servers configured.".to_owned()];
        }
        let mut lines = Vec::new();
        for definition in &manager.definitions {
            let ServerDefinition::Enabled { server } = definition else {
                let ServerDefinition::Disabled { id } = definition else {
                    unreachable!();
                };
                lines.push(format!("{id} · disabled"));
                continue;
            };
            let active = manager
                .clients
                .values()
                .filter(|client| lock(client).id == server.id)
                .cloned()
                .collect::<Vec<_>>();
            let failures = manager
                .failures
                .values()
                .filter(|(id, _, _)| *id == server.id)
                .collect::<Vec<_>>();
            if active.is_empty() && failures.is_empty() {
                let suffixes = server
                    .file_types
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                if executable(server, Path::new(&cwd)).is_none() {
                    lines.push(format!(
                        "{} · unavailable · {suffixes} · {}",
                        server.id,
                        unavailable_reason(server)
                    ));
                } else {
                    lines.push(format!(
                        "{} · idle · {suffixes} · {}",
                        server.id, server.command
                    ));
                }
                continue;
            }
            for client in active {
                let client = lock(&client);
                let stderr = client.stderr();
                lines.push(
                    [
                        client.id.clone(),
                        "ready".to_owned(),
                        client.root.display().to_string(),
                        client.failed.clone().unwrap_or_default(),
                        stderr,
                    ]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                );
            }
            for (_, root, reason) in failures {
                lines.push(format!(
                    "{} · failed · {} · {reason}",
                    server.id,
                    root.display()
                ));
            }
        }
        lines
    }

    #[napi(catch_unwind)]
    pub fn query(
        &self,
        request: String,
        cwd: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<QueryTask> {
        AsyncTask::new(QueryTask {
            state: self.state.clone(),
            request,
            cwd,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn restart(&self, server: Option<String>) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            state: self.state.clone(),
            action: Action::Restart(server),
        })
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            state: self.state.clone(),
            action: Action::Close,
        })
    }
}
