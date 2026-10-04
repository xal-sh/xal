use super::*;

pub struct ShellRequest {
    pub session_id: String,
    pub sandbox_id: String,
    pub command: String,
    pub cwd: String,
    pub persistent_launch: Vec<String>,
    pub isolated_launch: Vec<String>,
    pub environment: Vec<EnvironmentVariable>,
}

pub struct ShellManager {
    entries: Arc<Mutex<HashMap<String, Arc<PersistentEntry>>>>,
}

impl Default for ShellManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn execute(&self, request: ShellRequest) -> std::io::Result<ShellExecution> {
        if request.session_id.is_empty() || request.sandbox_id.is_empty() {
            return Err(Error::new(
                std::io::ErrorKind::InvalidInput,
                "native shell identity is required".to_owned(),
            ));
        }
        if request.cwd.is_empty() {
            return Err(Error::new(
                std::io::ErrorKind::InvalidInput,
                "native shell cwd is required".to_owned(),
            ));
        }
        let key = format!("{}\0{}", request.session_id, request.sandbox_id);
        let mut entries = lock(&self.entries);
        let mut entry = entries.get(&key).cloned();
        if entry
            .as_ref()
            .is_some_and(|entry| entry.dead.load(std::sync::atomic::Ordering::Acquire))
        {
            entries.remove(&key);
            entry = None;
        }
        if entry
            .as_ref()
            .is_some_and(|entry| lock(&entry.active).is_some())
        {
            drop(entries);
            return self.execute_isolated(request);
        }
        if entry
            .as_ref()
            .is_some_and(|entry| entry.workspace != request.cwd)
        {
            if let Some(previous) = entries.remove(&key) {
                process_signal(&previous.process, true);
            }
            entry = None;
        }
        let entry = match entry {
            Some(entry) => entry,
            None => {
                let process = spawn_process(ProcessRequest {
                    launch: request.persistent_launch,
                    cwd: request.cwd.clone(),
                    environment: request.environment,
                    stdin: true,
                })?;
                let entry = Arc::new(PersistentEntry {
                    process,
                    workspace: request.cwd,
                    active: Mutex::new(None),
                    dead: AtomicBool::new(false),
                });
                entries.insert(key, entry.clone());
                let dispatcher = entry.clone();
                thread::spawn(move || dispatch_persistent(dispatcher));
                entry
            }
        };
        drop(entries);
        let marker = marker();
        let needle = format!("\n{marker}:").into_bytes();
        let state = RunState::new(entry.process.clone());
        *lock(&entry.active) = Some(ActiveRun {
            state: state.clone(),
            holdback: needle.len() + 16,
            needle,
            pending: Vec::new(),
        });
        let run_function = format!("{marker}_run");
        let status_variable = format!("{marker}_status");
        let trap_variable = format!("{marker}_trap");
        let framed = format!(
            "{run_function}() {{ eval \"$1\"; }}\n{trap_variable}=\"$(trap | grep -E ' (SIG)?INT$')\"\ntrap 'return 124' INT\n{run_function} {} </dev/null 2>&1\n{status_variable}=$?\ntrap - INT\n[ -z \"${trap_variable}\" ] || eval \"${trap_variable}\"\nunset {trap_variable}\nunset -f {run_function}\nprintf '\\n%s:%s\\n' {} \"${status_variable}\"\nunset {status_variable}\n",
            shell_quote(&request.command),
            shell_quote(&marker)
        );
        if let Err(error) = process_write(&entry.process, framed.as_bytes()) {
            *lock(&entry.active) = None;
            state.fail(error.to_string());
        }
        Ok(ShellExecution { state })
    }

    pub fn execute_isolated(&self, request: ShellRequest) -> std::io::Result<ShellExecution> {
        let process = spawn_process(ProcessRequest {
            launch: request.isolated_launch,
            cwd: request.cwd,
            environment: request.environment,
            stdin: false,
        })?;
        let state = RunState::new(process.clone());
        let dispatcher = state.clone();
        thread::spawn(move || dispatch_isolated(process, dispatcher));
        Ok(ShellExecution { state })
    }

    pub fn shutdown_session(&self, session_id: &str) -> std::io::Result<()> {
        let prefix = format!("{session_id}\0");
        let removed = {
            let mut entries = lock(&self.entries);
            let keys = entries
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| entries.remove(&key))
                .collect::<Vec<_>>()
        };
        let mut errors = Vec::new();
        for entry in removed {
            process_signal(&entry.process, true);
            if let Err(error) = crate::process::wait_process(&entry.process) {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            return Ok(());
        }
        Err(std::io::Error::other(errors.join("\n")))
    }

    pub fn shutdown_all(&self) -> std::io::Result<()> {
        let removed = lock(&self.entries)
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        for entry in &removed {
            process_signal(&entry.process, true);
        }
        let errors = removed
            .iter()
            .filter_map(|entry| crate::process::wait_process(&entry.process).err())
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        if errors.is_empty() {
            return Ok(());
        }
        Err(Error::other(errors.join("\n")))
    }
}
impl Drop for ShellManager {
    fn drop(&mut self) {
        let removed = {
            let mut entries = lock(&self.entries);
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }
}
