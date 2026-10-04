use std::env;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use xal_host::agent::{Agent, Journal, Outcome};
use xal_host::{Error, Result};
use xal_services::background::{self, Action, Entry, Lease, State, Status, Store};
use xal_services::config::agent_home;
use xal_services::credentials::new_id;

pub struct Worker {
    pub store: Store,
    pub id: String,
}

impl Worker {
    pub async fn drive(&self, agent: &mut Agent<'_>) -> Result<Outcome> {
        let loaded = agent.snapshot()?;
        let now = background::now().map_err(failure)?;
        let mut state = State {
            version: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            session_id: loaded.meta.id,
            session_path: agent
                .journal()
                .ok_or_else(|| failure("worker requires a journal"))?
                .path()
                .into(),
            cwd: agent.session().cwd.clone(),
            title: loaded.title.as_deref().map(|title| agent.redact(title)),
            log: self.store.directory.join(format!("worker-{}.log", self.id)),
            pid: std::process::id(),
            worker_id: self.id.clone(),
            started_at: now,
            updated_at: now,
            status: Status::Running,
            activity: Some("continuing".into()),
            detail: None,
        };
        self.store.publish(&state).map_err(failure)?;
        agent.defer_interactions(true);
        let control = agent.control();
        let result = {
            let run = agent.continue_turn(false);
            tokio::pin!(run);
            tokio::select! {
                result = &mut run => result,
                request = self.control(&mut state) => {
                    match request {
                        Ok(Action::Handoff) => control.pause()?,
                        Ok(Action::Stop) | Err(_) => control.interrupt(),
                    }
                    let result = run.await;
                    match request { Ok(_) => result, Err(error) => Err(error) }
                }
            }
        };
        let handoff = agent.handoff().await;
        let (journal, cleanup) = match handoff {
            Ok(journal) => (Some(journal), agent.flush_recording()),
            Err(error) => (None, Err(error)),
        };
        let result = match (result, cleanup) {
            (result, Ok(())) => result,
            (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(failure(format!(
                "{error}; worker cleanup failed: {cleanup}"
            ))),
        };
        state.status = match &result {
            Ok(Outcome::Completed { .. }) => Status::Done,
            Ok(Outcome::NeedsInput { .. }) => Status::NeedsInput,
            Ok(Outcome::Paused { .. }) => Status::Handoff,
            Ok(Outcome::Interrupted { .. }) => Status::Stopped,
            Ok(Outcome::Failed { .. }) | Err(_) => Status::Failed,
        };
        state.detail = match &result {
            Err(error) => Some(agent.redact(&error.to_string())),
            Ok(Outcome::Failed { error, .. }) => Some(agent.redact(error)),
            Ok(Outcome::NeedsInput { .. }) => {
                Some("an interactive tool needs input; attach to answer the pending request".into())
            }
            _ => None,
        };
        state.updated_at = background::now().map_err(failure)?;
        state.activity = None;
        self.store.publish(&state).map_err(failure)?;
        if let Some(journal) = journal {
            drop(journal);
            self.store.release(&self.id).map_err(failure)?;
        }
        result
    }

    async fn control(&self, state: &mut State) -> Result<Action> {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        let signal = stop_signal();
        tokio::pin!(signal);
        loop {
            tokio::select! {
                result = &mut signal => { result?; return Ok(Action::Stop); },
                _ = interval.tick() => {
                    self.store.assert_owner(&self.id).map_err(failure)?;
                    if let Some(request) = self.store.control(&self.id).map_err(failure)? { return Ok(request.action); }
                    let now = background::now().map_err(failure)?;
                    if now.saturating_sub(state.updated_at) >= 5000 { state.updated_at = now; self.store.publish(state).map_err(failure)?; }
                }
            }
        }
    }
}

#[cfg(unix)]
pub(crate) async fn stop_signal() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt()).map_err(failure)?;
    let mut terminate = signal(SignalKind::terminate()).map_err(failure)?;
    let _hangup = signal(SignalKind::hangup()).map_err(failure)?;
    tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    Ok(())
}
#[cfg(not(unix))]
pub(crate) async fn stop_signal() -> Result<()> {
    tokio::signal::ctrl_c().await.map_err(failure)
}

pub async fn run(args: &[String]) -> Result<u8> {
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let Some(command) = args.first().map(String::as_str) else {
        return listing(&home);
    };
    if matches!(command, "attach" | "stop" | "clear" | "status" | "log")
        && (2..=3).contains(&args.len())
        && let Entry::Unpublished(lease) = background::find(&home, &args[1]).map_err(failure)?
    {
        if command == "status" {
            println!("{}", json!({"lease":lease,"effective":"unpublished"}));
            return Ok(0);
        }
        if command == "log" {
            return Err(failure(
                "worker never published its log path; use bg clear or attach to recover ownership",
            ));
        }
        let (mut journal, loaded) = recover_unpublished(
            &home,
            &lease,
            args.get(2).map(String::as_str),
            command == "clear",
        )?;
        if command == "attach" {
            return crate::headless::attached((journal, loaded), false).await;
        }
        if command == "stop" {
            deny_pending(&mut journal, &loaded)?;
        }
        println!(
            "Recovered unpublished background entry {}. The transcript is retained.",
            lease.session_id
        );
        return Ok(0);
    }
    match command {
        "--help" | "-h" => {
            println!(
                "usage: xal-rust bg [list | start <session-id-or-path> | status <id> | log <id> | attach <id> | stop <id> | clear [id]]\nWorkers retain recorded account bindings and defer interactive input. For an unpublished lease outside the session index, append its journal path to attach, stop, or clear. The native attach path is headless; use xal bg attach for the current TUI."
            );
            Ok(0)
        }
        "list" if args.len() == 1 => listing(&home),
        "start" | "detach" if args.len() == 2 => launch(&home, &args[1]).await,
        "worker" if args.len() == 4 => {
            let store = Store::new(&home, &args[1]).map_err(failure)?;
            store.assert_owner(&args[2]).map_err(failure)?;
            let path = std::path::PathBuf::from(&args[3]);
            let worker = Worker {
                store,
                id: args[2].clone(),
            };
            let result = crate::headless::worker(&path, &worker).await;
            if worker.store.lease().map_err(failure)?.is_some() {
                let owner =
                    xal_services::session_lock::SessionLock::acquire(&path).map_err(failure)?;
                worker.store.assert_owner(&worker.id).map_err(failure)?;
                if let Some(mut state) = worker.store.state().map_err(failure)? {
                    state.status = Status::Failed;
                    state.activity = None;
                    state.detail = Some("worker setup or cleanup failed; inspect its log".into());
                    state.updated_at = background::now().map_err(failure)?;
                    worker.store.publish(&state).map_err(failure)?;
                }
                drop(owner);
                worker.store.release(&worker.id).map_err(failure)?;
            }
            result
        }
        "status" | "log" if args.len() == 2 => {
            let Entry::Worker(state) = background::find(&home, &args[1]).map_err(failure)? else {
                return Err(failure("worker state disappeared"));
            };
            if command == "log" {
                print!(
                    "{}",
                    crate::sessions::redactor(&home, &state.cwd)?
                        .redact(&std::fs::read_to_string(&state.log).map_err(failure)?)
                );
            } else {
                println!("{}", view(&state)?);
            }
            Ok(0)
        }
        "attach" | "stop" if args.len() == 2 => {
            let Entry::Worker(mut state) = background::find(&home, &args[1]).map_err(failure)?
            else {
                return Err(failure("worker state disappeared"));
            };
            let store = Store::new(&home, &state.session_id).map_err(failure)?;
            let attach = store.claim_attach().map_err(failure)?;
            let started = Instant::now();
            let died = !background::alive(state.pid).map_err(failure)?;
            if state.status == Status::Running && !died {
                state = request(
                    &store,
                    &state,
                    if command == "attach" {
                        Action::Handoff
                    } else {
                        Action::Stop
                    },
                )
                .await?;
            }
            let mut died = !background::alive(state.pid).map_err(failure)?;
            while !died {
                let Some(lease) = store.lease().map_err(failure)? else {
                    break;
                };
                if lease.worker_id != state.worker_id {
                    return Err(failure("background ownership changed during handoff"));
                }
                if started.elapsed()
                    >= Duration::from_secs(if command == "attach" { 20 } else { 15 })
                {
                    return Err(failure(
                        "worker has not released ownership before the deadline",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                died = !background::alive(state.pid).map_err(failure)?;
            }
            let (mut journal, loaded) = Journal::resume(&state.session_path)?;
            if store
                .state()
                .map_err(failure)?
                .is_none_or(|current| current.worker_id != state.worker_id)
            {
                return Err(failure("background ownership changed during handoff"));
            }
            let abandoned = died && store.lease().map_err(failure)?.is_some();
            if abandoned {
                store.assert_owner(&state.worker_id).map_err(failure)?;
            }
            if command == "stop" {
                if state.status == Status::NeedsInput || (died && state.status == Status::Running) {
                    deny_pending(&mut journal, &loaded)?;
                    state.status = Status::Stopped;
                    state.detail = Some("pending interactive request denied".into());
                    state.updated_at = background::now().map_err(failure)?;
                    xal_services::storage::write_json(
                        &store.directory.join("state.json"),
                        &serde_json::to_value(&state).map_err(failure)?,
                    )
                    .map_err(failure)?;
                }
                if abandoned {
                    store.release(&state.worker_id).map_err(failure)?;
                }
                attach.release().map_err(failure)?;
                println!("{}", view(&state)?);
                return Ok(0);
            }
            if abandoned {
                store.release(&state.worker_id).map_err(failure)?;
            }
            if store.lease().map_err(failure)?.is_some() && !died {
                return Err(failure("worker has not released its lease"));
            }
            if state.status == Status::NeedsInput {
                attach.release().map_err(failure)?;
                println!(
                    "Session {} needs interactive input. Its background entry and pending request at {} are retained. Use xal bg attach to answer with the current TUI.",
                    state.session_id,
                    state.session_path.display()
                );
                return Ok(1);
            }
            let started = Instant::now();
            while background::alive(state.pid).map_err(failure)? {
                if started.elapsed() >= Duration::from_secs(15) {
                    return Err(failure(
                        "worker has released ownership but has not exited; background entry retained",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            attach.release().map_err(failure)?;
            std::fs::remove_dir_all(&store.directory).map_err(failure)?;
            if matches!(state.status, Status::Running | Status::Handoff) {
                return crate::headless::attached((journal, loaded), !died).await;
            }
            println!(
                "Attached session {} at {} ({:?}).",
                state.session_id,
                state.session_path.display(),
                state.status
            );
            Ok(0)
        }
        "clear" if args.len() <= 2 => {
            let states = match args.get(1) {
                Some(id) => vec![background::find(&home, id).map_err(failure)?],
                None => background::list(&home).map_err(failure)?,
            };
            for entry in states {
                let state = match entry {
                    Entry::Worker(state) => state,
                    Entry::Unpublished(lease) => {
                        recover_unpublished(&home, &lease, None, true)?;
                        println!("Cleared {}", lease.session_id);
                        continue;
                    }
                };
                if background::alive(state.pid).map_err(failure)? {
                    if args.len() == 2 {
                        return Err(failure("worker is alive; stop it first"));
                    }
                    continue;
                }
                let _owner = xal_services::session_lock::SessionLock::acquire(&state.session_path)
                    .map_err(failure)?;
                Store::new(&home, &state.session_id)
                    .map_err(failure)?
                    .remove()
                    .map_err(failure)?;
                println!("Cleared {}", state.session_id);
            }
            Ok(0)
        }
        _ => Err(failure("invalid background command; see bg --help")),
    }
}

async fn launch(home: &Path, target: &str) -> Result<u8> {
    let path = crate::sessions::resolve(home, target)?;
    let (journal, loaded) = Journal::resume(&path)?;
    let store = Store::new(home, &loaded.meta.id).map_err(failure)?;
    let worker = new_id().map_err(failure)?;
    let recorded_cwd = Path::new(&loaded.current.cwd);
    let cwd = if recorded_cwd.is_dir() {
        recorded_cwd.to_path_buf()
    } else {
        env::current_dir().map_err(failure)?
    };
    let redactor = crate::sessions::redactor(home, &cwd)?;
    let now = background::now().map_err(failure)?;
    let mut startup = State {
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        session_id: loaded.meta.id.clone(),
        session_path: path.canonicalize().map_err(failure)?,
        cwd: cwd.clone(),
        title: loaded.title.as_deref().map(|title| redactor.redact(title)),
        log: store.directory.join(format!("worker-{worker}.log")),
        pid: std::process::id(),
        worker_id: worker.clone(),
        started_at: now,
        updated_at: now,
        status: Status::Running,
        activity: Some("starting".into()),
        detail: None,
    };
    store.claim_start(&startup).map_err(failure)?;
    let result = async {
        let log_path = store.directory.join(format!("worker-{worker}.log"));
        let log = xal_services::storage::create_secure(&log_path).map_err(failure)?;
        drop(journal);
        let mut child = background::spawn(
            &env::current_exe().map_err(failure)?,
            &[
                "bg".into(),
                "worker".into(),
                loaded.meta.id.clone(),
                worker.clone(),
                path.canonicalize()
                    .map_err(failure)?
                    .to_string_lossy()
                    .into_owned(),
            ],
            &cwd,
            log,
        )
        .map_err(failure)?;
        let result = async {
            startup.pid = child.id();
            if store
                .state()
                .map_err(failure)?
                .is_some_and(|state| state.activity.as_deref() == Some("starting"))
            {
                xal_services::storage::write_json(
                    &store.directory.join("startup.json"),
                    &json!(startup),
                )
                .map_err(failure)?;
            }
            let started = Instant::now();
            loop {
                if let Some(state) = store.state().map_err(failure)?
                    && state.worker_id == worker
                    && state.pid == child.id()
                    && state.activity.as_deref() != Some("starting")
                {
                    return Ok(());
                }
                if child.try_wait().map_err(failure)?.is_some() {
                    return Err(failure(format!(
                        "worker exited during startup; see {}",
                        log_path.display()
                    )));
                }
                if started.elapsed() >= Duration::from_secs(15) {
                    return Err(failure("worker did not become ready in 15 seconds"));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        .await;
        if let Err(error) = result {
            if child.try_wait().map_err(failure)?.is_none() {
                child.kill().map_err(failure)?;
                child.wait().map_err(failure)?;
            }
            return Err(error);
        }
        std::thread::spawn(move || {
            if let Err(error) = child.wait() {
                eprintln!("background worker reap failed: {error}");
            }
        });
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let owner = xal_services::session_lock::SessionLock::acquire(&path).map_err(|cleanup| {
            failure(format!(
                "{error}; startup ownership cleanup failed: {cleanup}"
            ))
        })?;
        store
            .assert_owner(&worker)
            .map_err(|cleanup| failure(format!("{error}; startup lease changed: {cleanup}")))?;
        startup.status = Status::Failed;
        startup.activity = None;
        startup.detail = Some("worker startup failed; inspect its log".into());
        startup.updated_at = background::now().map_err(failure)?;
        xal_services::storage::write_json(&store.directory.join("state.json"), &json!(startup))
            .map_err(failure)?;
        drop(owner);
        if store.lease().map_err(failure)?.is_some() {
            store
                .release(&worker)
                .map_err(|cleanup| failure(format!("{error}; lease cleanup failed: {cleanup}")))?;
        }
        return Err(error);
    }
    println!(
        "Detached session {}. Log: {}",
        loaded.meta.id,
        store
            .directory
            .join(format!("worker-{worker}.log"))
            .display()
    );
    Ok(0)
}

async fn request(store: &Store, state: &State, action: Action) -> Result<State> {
    store.request(&state.worker_id, action).map_err(failure)?;
    let started = Instant::now();
    loop {
        let current = store
            .state()
            .map_err(failure)?
            .ok_or_else(|| failure("background state disappeared"))?;
        if current.worker_id != state.worker_id {
            return Err(failure("background worker changed during handoff"));
        }
        if current.status != Status::Running && store.lease().map_err(failure)?.is_none() {
            return Ok(current);
        }
        if !background::alive(current.pid).map_err(failure)? {
            return Ok(current);
        }
        if started.elapsed() >= Duration::from_secs(if action == Action::Handoff { 20 } else { 15 })
        {
            return Err(failure(
                "worker did not acknowledge the request before its deadline; ownership was not taken",
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn deny_pending(journal: &mut Journal, loaded: &xal_services::sessions::Loaded) -> Result<()> {
    let items = xal_host::agent::history::active(&loaded.records)?;
    let mut records = Vec::new();
    for item in xal_host::agent::history::pending_calls(&items) {
        let xal_host::Item::ToolCall { call_id, name, .. } = item else {
            return Err(failure("invalid pending tool"));
        };
        let output = "User stopped the background session before answering the pending request.";
        records.push(json!({"type":"event","event":{"type":"tool_finished","callId":call_id,"tool":name,"title":name,"readOnly":false,"output":output,"denial":"user"}}));
        records.push(
            json!({"type":"item","item":{"type":"tool_result","callId":call_id,"output":output}}),
        );
    }
    journal.append_batch(&records)?;
    journal.snapshot()?;
    Ok(())
}
fn view(state: &State) -> Result<serde_json::Value> {
    let home =
        agent_home(env::var("XAL_HOME").ok().as_deref(), env::home_dir()).map_err(failure)?;
    let cwd = if state.cwd.is_dir() {
        state.cwd.clone()
    } else {
        env::current_dir().map_err(failure)?
    };
    let redactor = crate::sessions::redactor(&home, &cwd)?;
    let alive = background::alive(state.pid).map_err(failure)?;
    Ok(
        redactor.redact_json(&json!({"state":state,"alive":alive,"effective":if state.status == Status::Running && !alive { json!("died") } else { json!(state.status) }})),
    )
}
fn recover_unpublished(
    home: &Path,
    lease: &Lease,
    target: Option<&str>,
    clear: bool,
) -> Result<(Journal, xal_services::sessions::Loaded)> {
    let store = Store::new(home, &lease.session_id).map_err(failure)?;
    let attach = if clear {
        None
    } else {
        Some(store.claim_attach().map_err(failure)?)
    };
    let path = crate::sessions::resolve(home, target.unwrap_or(&lease.session_id))?;
    let (journal, loaded) = Journal::resume(&path)?;
    if loaded.meta.id != lease.session_id {
        return Err(failure("recovery journal belongs to another session"));
    }
    store.assert_owner(&lease.worker_id).map_err(failure)?;
    if store.state().map_err(failure)?.is_some() {
        return Err(failure(
            "worker published state during recovery; retry using its state",
        ));
    }
    store.release(&lease.worker_id).map_err(failure)?;
    if let Some(attach) = attach {
        attach.release().map_err(failure)?;
    }
    std::fs::remove_dir_all(&store.directory).map_err(failure)?;
    Ok((journal, loaded))
}

fn listing(home: &Path) -> Result<u8> {
    println!(
        "{}",
        serde_json::to_string_pretty(
            &background::list(home)
                .map_err(failure)?
                .iter()
                .map(|entry| match entry {
                    Entry::Worker(state) => view(state),
                    Entry::Unpublished(lease) =>
                        Ok(json!({"lease":lease,"effective":"unpublished"})),
                })
                .collect::<Result<Vec<_>>>()?
        )
        .map_err(failure)?
    );
    Ok(0)
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xal_host::agent::{Options, metadata};
    use xal_host::{
        Cancellation, Host, Plugin, Provider, ProviderEvent, Registration, SessionKind,
    };
    use xal_services::redactor::Redactor;
    use xal_services::session_lock::SessionLock;

    struct FailedCleanup;

    impl Plugin for FailedCleanup {
        fn name(&self) -> &str {
            "fixture"
        }
        fn register(&mut self, registration: &mut Registration) -> Result<()> {
            registration.session_disposer(Box::new(|_, _| {
                Box::pin(async { Err(failure("fixture cleanup failed")) })
            }));
            registration.provider(
                "fixture",
                Provider {
                    settle: None,
                    models: vec!["fixture".into()],
                    stream: Box::new(|_, _, sender| {
                        Box::pin(
                            async move { sender.send(ProviderEvent::Done { usage: None }).await },
                        )
                    }),
                },
            )
        }
    }

    #[tokio::test]
    async fn failed_handoff_retains_lease_until_agent_releases_transcript() {
        let root = env::temp_dir().join(format!("xal-worker-{}", new_id().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let mut host = Host::new(vec![Box::new(FailedCleanup)], Cancellation::default());
        host.start().await.unwrap();
        let id = new_id().unwrap();
        let session = host
            .session(id.clone(), root.clone(), SessionKind::Interactive, false)
            .unwrap();
        let options = Options {
            provider: "fixture".into(),
            profile: None,
            model: "fixture".into(),
            mode: "normal".into(),
            instructions: String::new(),
            thinking: None,
            context_window: 100_000,
            image_input: false,
            summary_target: None,
            compaction_limit: None,
            output_schema: None,
            artifacts: root.join("artifacts"),
        };
        let redactor = Redactor::new(Vec::new()).unwrap();
        let path = root.join("session.jsonl");
        let journal =
            Journal::create(&path, &metadata(&session, &options, &redactor).unwrap()).unwrap();
        let worker = Worker {
            store: Store::new(&root, &id).unwrap(),
            id: new_id().unwrap(),
        };
        worker.store.claim(&worker.id).unwrap();
        let mut receive = |_| Ok(());
        let mut agent = Agent::new(
            &host,
            session,
            options,
            &redactor,
            Some(journal),
            &mut receive,
        )
        .unwrap();
        let error = worker.drive(&mut agent).await.unwrap_err();
        assert!(error.to_string().contains("fixture cleanup failed"));
        assert_eq!(
            worker.store.state().unwrap().unwrap().status,
            Status::Failed
        );
        worker.store.assert_owner(&worker.id).unwrap();
        assert!(SessionLock::acquire(&path).is_err());
        drop(agent);
        let owner = SessionLock::acquire(&path).unwrap();
        worker.store.assert_owner(&worker.id).unwrap();
        drop(owner);
        worker.store.release(&worker.id).unwrap();
        assert!(worker.store.lease().unwrap().is_none());
        host.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
