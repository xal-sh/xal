use super::*;

#[napi(object)]
pub struct NativeShellRequest {
    pub session_id: String,
    pub sandbox_id: String,
    pub command: String,
    pub cwd: String,
    pub persistent_launch: Vec<String>,
    pub isolated_launch: Vec<String>,
    pub environment: Vec<NativeEnvironmentVariable>,
}

#[napi]
pub struct NativeShellManager {
    entries: Arc<Mutex<HashMap<String, Arc<PersistentEntry>>>>,
}

#[napi]
impl NativeShellManager {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[napi(catch_unwind)]
    pub fn execute(&self, request: NativeShellRequest) -> napi::Result<NativeShellExecution> {
        if request.session_id.is_empty() || request.sandbox_id.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
                "native shell identity is required".to_owned(),
            ));
        }
        if request.cwd.is_empty() {
            return Err(Error::new(
                Status::InvalidArg,
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
                let process = spawn_process(NativeProcessRequest {
                    launch: request.persistent_launch,
                    cwd: request.cwd.clone(),
                    environment: request.environment,
                    stdin: true,
                    tty: None,
                    cols: None,
                    rows: None,
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
            state.fail(error.reason);
        }
        Ok(NativeShellExecution { state })
    }

    fn execute_isolated(&self, request: NativeShellRequest) -> napi::Result<NativeShellExecution> {
        let process = spawn_process(NativeProcessRequest {
            launch: request.isolated_launch,
            cwd: request.cwd,
            environment: request.environment,
            stdin: false,
            tty: None,
            cols: None,
            rows: None,
        })?;
        let state = RunState::new(process.clone());
        let dispatcher = state.clone();
        thread::spawn(move || dispatch_isolated(process, dispatcher));
        Ok(NativeShellExecution { state })
    }

    #[napi(catch_unwind)]
    pub fn dispose_session(&self, session_id: String) {
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
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }

    #[napi(catch_unwind)]
    pub fn dispose_all(&self) {
        let removed = {
            let mut entries = lock(&self.entries);
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        for entry in removed {
            process_signal(&entry.process, true);
        }
    }
}
impl Drop for NativeShellManager {
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
