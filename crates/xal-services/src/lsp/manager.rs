use super::*;

struct Instance {
    id: String,
    root: PathBuf,
    stopped: AtomicBool,
    client: Mutex<Option<RpcClient>>,
    status: Mutex<InstanceStatus>,
}

enum InstanceStatus {
    Starting,
    Ready,
    Failed(String),
}

struct State {
    instances: BTreeMap<String, Arc<Instance>>,
    closing: bool,
}

pub struct Manager {
    definitions: Vec<ServerDefinition>,
    state: Mutex<State>,
    lifecycle: Mutex<()>,
    app_name: String,
    app_version: String,
}

impl Manager {
    pub fn new(
        definitions: Vec<ServerDefinition>,
        app_name: String,
        app_version: String,
    ) -> std::io::Result<Self> {
        config::validate_definitions(&definitions)?;
        Ok(Self {
            definitions,
            state: Mutex::new(State {
                instances: BTreeMap::new(),
                closing: false,
            }),
            lifecycle: Mutex::new(()),
            app_name,
            app_version,
        })
    }

    pub fn has_available_server(&self, cwd: &Path) -> bool {
        let state = lock(&self.state);
        if state.closing {
            return false;
        }
        if state.instances.values().any(|instance| {
            !instance.stopped.load(Ordering::Acquire)
                && matches!(*lock(&instance.status), InstanceStatus::Ready)
        }) {
            return true;
        }
        self.definitions.iter().any(|definition| match definition {
            ServerDefinition::Enabled { server } => {
                executable(server, cwd).is_some() || config::may_resolve_from_another_root(server)
            }
            ServerDefinition::Disabled { .. } => false,
        })
    }

    pub fn status_lines(&self, cwd: &Path) -> Vec<String> {
        if self.definitions.is_empty() {
            return vec!["No language servers configured.".into()];
        }
        let instances = lock(&self.state)
            .instances
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut lines = Vec::new();
        for definition in &self.definitions {
            let server = match definition {
                ServerDefinition::Enabled { server } => server,
                ServerDefinition::Disabled { id } => {
                    lines.push(format!("{id} · disabled"));
                    continue;
                }
            };
            let active = instances
                .iter()
                .filter(|instance| instance.id == server.id)
                .collect::<Vec<_>>();
            if active.is_empty() {
                let suffixes = server
                    .file_types
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                if executable(server, cwd).is_some() {
                    lines.push(format!(
                        "{} · idle · {suffixes} · {}",
                        server.id, server.command
                    ));
                } else {
                    lines.push(format!(
                        "{} · unavailable · {suffixes} · {}",
                        server.id,
                        unavailable_reason(server)
                    ));
                }
                continue;
            }
            for instance in active {
                let status = lock(&instance.status);
                lines.push(match &*status {
                    InstanceStatus::Starting => format!(
                        "{} · idle · {} · initializing",
                        instance.id,
                        instance.root.display()
                    ),
                    InstanceStatus::Ready => {
                        format!("{} · ready · {}", instance.id, instance.root.display())
                    }
                    InstanceStatus::Failed(reason) => format!(
                        "{} · failed · {} · {reason}",
                        instance.id,
                        instance.root.display()
                    ),
                });
            }
        }
        lines
    }

    pub fn query(
        &self,
        query: &Query,
        cwd: &Path,
        cancel: &dyn Fn() -> bool,
    ) -> std::io::Result<String> {
        query.validate()?;
        cancelled(cancel)?;
        let path = cwd.join(&query.file_path);
        let metadata = fs::metadata(&path)
            .map_err(|error| failed(format!("Cannot inspect {}: {error}", query.file_path)))?;
        if !metadata.is_file() {
            return Err(failed(format!("Path is not a file: {}", query.file_path)));
        }
        let path = fs::canonicalize(&path)?;
        let (config, language_id, suffix) = match_server(&self.definitions, &path)?;
        let root = server_root(&path, cwd, &config.root_markers)?;
        let key = client_key(&config.id, &root);
        let instance = {
            let mut state = lock(&self.state);
            if state.closing {
                return Err(failed("language server manager is shutting down"));
            }
            state
                .instances
                .entry(key)
                .or_insert_with(|| {
                    Arc::new(Instance {
                        id: config.id.clone(),
                        root: root.clone(),
                        stopped: AtomicBool::new(false),
                        client: Mutex::new(None),
                        status: Mutex::new(InstanceStatus::Starting),
                    })
                })
                .clone()
        };
        let cancel = || cancel() || instance.stopped.load(Ordering::Acquire);
        let mut client = loop {
            cancelled(&cancel)?;
            match instance.client.try_lock() {
                Ok(client) => break client,
                Err(std::sync::TryLockError::WouldBlock) => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(failed("LSP client state poisoned"));
                }
            }
        };
        cancelled(&cancel)?;
        let result: std::io::Result<String> = (|| {
            if client.is_none() {
                let command = executable(&config, &root).ok_or_else(|| {
                    failed(format!(
                        "LSP server {} is unavailable for {suffix}: {}",
                        config.id,
                        unavailable_reason(&config)
                    ))
                })?;
                *client = Some(RpcClient::start(
                    &config,
                    &root,
                    &command,
                    &self.app_name,
                    &self.app_version,
                    &cancel,
                )?);
                *lock(&instance.status) = InstanceStatus::Ready;
            }
            let output = query::query_client(
                client.as_mut().expect("initialized LSP client"),
                &language_id,
                &path,
                query,
                &cwd.to_string_lossy(),
                &cancel,
            )?;
            cancelled(&cancel)?;
            Ok(output)
        })();
        match result {
            Ok(output) => Ok(output),
            Err(error) => {
                let mut kind = error.kind();
                let mut reason = error.to_string();
                if let Some(mut running) = client.take() {
                    let stderr = running.stderr();
                    if !stderr.is_empty() {
                        reason.push_str(&format!(" · {stderr}"));
                    }
                    if let Err(cleanup) = running.stop(false) {
                        kind = ErrorKind::Other;
                        reason.push_str(&format!("; cleanup failed: {cleanup}"));
                    }
                }
                *lock(&instance.status) = InstanceStatus::Failed(reason.clone());
                Err(Error::new(kind, reason))
            }
        }
    }

    pub fn restart(&self, server: Option<&str>) -> std::io::Result<()> {
        if let Some(id) = server {
            match self.definitions.iter().find(|definition| match definition {
                ServerDefinition::Enabled { server } => server.id == id,
                ServerDefinition::Disabled { id: disabled } => disabled == id,
            }) {
                None => return Err(failed(format!("unknown language server: {id}"))),
                Some(ServerDefinition::Disabled { .. }) => {
                    return Err(failed(format!("language server is disabled: {id}")));
                }
                Some(ServerDefinition::Enabled { .. }) => {}
            }
        }
        self.stop(server, false)
    }

    pub fn close(&self) -> std::io::Result<()> {
        self.stop(None, true)
    }

    fn stop(&self, server: Option<&str>, closing: bool) -> std::io::Result<()> {
        let _lifecycle = lock(&self.lifecycle);
        let instances = {
            let mut state = lock(&self.state);
            if state.closing && !closing {
                return Err(failed("language server manager is shutting down"));
            }
            state.closing |= closing;
            state
                .instances
                .values()
                .filter(|instance| server.is_none_or(|server| server == instance.id))
                .inspect(|instance| instance.stopped.store(true, Ordering::Release))
                .cloned()
                .collect::<Vec<_>>()
        };
        let result = thread::scope(|scope| {
            let jobs = instances
                .into_iter()
                .map(|instance| {
                    scope.spawn(move || {
                        if let Some(mut client) = lock(&instance.client).take() {
                            client.stop(true)?;
                        }
                        Ok::<(), Error>(())
                    })
                })
                .collect::<Vec<_>>();
            let mut failures = Vec::new();
            for job in jobs {
                match job.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => failures.push(error.to_string()),
                    Err(_) => failures.push("LSP cleanup thread panicked".into()),
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failed(format!(
                    "language server cleanup failed: {}",
                    failures.join("; ")
                )))
            }
        });
        lock(&self.state)
            .instances
            .retain(|_, instance| !instance.stopped.load(Ordering::Acquire));
        result
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        if self.close().is_err() {
            eprintln!("LSP cleanup failed");
        }
    }
}
