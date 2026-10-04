use super::*;
use xal_services::background::{self, State, Status, Store};

fn command(fixture: &Fixture, server: &Server, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xal-rust"))
        .args(["bg"])
        .args(args)
        .current_dir(&fixture.cwd)
        .env("XAL_HOME", &fixture.home)
        .env("HOME", &fixture.home)
        .env("SHELL", "/bin/sh")
        .env("XAL_OPENAI_BASE_URL", &server.url)
        .env("NO_PROXY", "*")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn successful(output: Output) -> Output {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn wait_state(store: &Store, predicate: impl Fn(&State) -> bool) -> State {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(state) = store.state().unwrap()
            && predicate(&state)
        {
            return state;
        }
        assert!(
            Instant::now() < deadline,
            "worker did not reach expected state: {:?}",
            store.state()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn seed(fixture: &Fixture, server: &Server) -> (PathBuf, Store) {
    successful(fixture.run(server, &["--mode", "yolo", "seed"], ""));
    let path = fixture.journals().pop().unwrap();
    let loaded = xal_services::sessions::load(&path).unwrap();
    let store = Store::new(&fixture.home, &loaded.meta.id).unwrap();
    (path, store)
}

#[test]
fn worker_defers_questions_after_effects_and_stop_denies_without_replay() {
    let fixture = Fixture::new();
    let server = Server::new(vec![
        answer("seeded"),
        call(
            "effect",
            "write",
            json!({"file_path":"marker.txt","content":"written once"}),
        ) + &done(),
        call(
            "question",
            "request_user_input",
            json!({"questions":[{"id":"choice","header":"Choice","question":"Continue?","options":[{"label":"Yes","description":"Continue"}]}]}),
        ) + &done(),
    ]);
    let (path, store) = seed(&fixture, &server);
    successful(command(
        &fixture,
        &server,
        &["start", path.to_str().unwrap()],
    ));
    let state = wait_state(&store, |state| state.status != Status::Running);
    assert_eq!(state.status, Status::NeedsInput, "{state:?}");
    wait_state(&store, |_| store.lease().unwrap().is_none());
    assert_eq!(
        fs::read_to_string(fixture.cwd.join("marker.txt")).unwrap(),
        "written once"
    );
    let loaded = xal_services::sessions::load(&path).unwrap();
    let pending = xal_host::agent::history::pending_calls(
        &xal_host::agent::history::active(&loaded.records).unwrap(),
    );
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0], xal_host::Item::ToolCall { call_id, .. } if call_id == "question")
    );
    let retained = command(&fixture, &server, &["attach", &store.id]);
    assert_eq!(retained.status.code(), Some(1));
    assert!(store.state().unwrap().is_some());
    successful(command(&fixture, &server, &["stop", &store.id]));
    assert_eq!(store.state().unwrap().unwrap().status, Status::Stopped);
    let loaded = xal_services::sessions::load(&path).unwrap();
    assert!(
        xal_host::agent::history::pending_calls(
            &xal_host::agent::history::active(&loaded.records).unwrap()
        )
        .is_empty()
    );
    assert_eq!(server.requests().len(), 3);
}

#[test]
fn worker_uses_custom_journal_path_and_never_reexecutes_unknown_pending_effects() {
    let fixture = Fixture::new();
    let server = Server::new(vec![answer("seeded"), answer("inspected without replay")]);
    let (path, store) = seed(&fixture, &server);
    let moved = fixture.root.join("outside-index.jsonl");
    fs::rename(path, &moved).unwrap();
    let (mut journal, _) = xal_host::agent::Journal::resume(&moved).unwrap();
    journal.append(&json!({"type":"item","item":{"type":"tool_call","callId":"unknown-effect","name":"write","args":{"file_path":"must-not-exist","content":"unsafe replay"}}})).unwrap();
    drop(journal);
    successful(command(
        &fixture,
        &server,
        &["start", moved.to_str().unwrap()],
    ));
    let state = wait_state(&store, |state| state.status != Status::Running);
    assert_eq!(state.status, Status::Done, "{state:?}");
    wait_state(&store, |_| store.lease().unwrap().is_none());
    assert!(!fixture.cwd.join("must-not-exist").exists());
    assert_eq!(state.session_path, moved);
    assert!(
        server.requests()[1]
            .to_string()
            .contains("inspect the workspace first")
    );
}

#[test]
fn unpublished_leases_are_visible_exclusively_recovered_and_fence_late_workers() {
    let fixture = Fixture::new();
    let server = Server::new(vec![answer("seeded")]);
    let (path, store) = seed(&fixture, &server);
    let worker = xal_services::credentials::new_id().unwrap();
    store.claim(&worker).unwrap();
    fs::write(store.directory.join("attach.lock"), b"").unwrap();
    let listed: Value =
        serde_json::from_slice(&successful(command(&fixture, &server, &["list"])).stdout).unwrap();
    assert_eq!(listed[0]["effective"], "unpublished");
    assert_eq!(listed[0]["lease"]["workerId"], worker);
    let owner = xal_services::session_lock::SessionLock::acquire(&path).unwrap();
    let busy = command(&fixture, &server, &["clear", &store.id]);
    assert!(!busy.status.success());
    assert!(String::from_utf8_lossy(&busy.stderr).contains("transcript owner"));
    assert!(store.lease().unwrap().is_some());
    drop(owner);
    let moved = fixture.root.join("outside-index.jsonl");
    fs::rename(path, &moved).unwrap();
    let before = fs::read(&moved).unwrap();
    assert!(
        !command(&fixture, &server, &["clear", &store.id])
            .status
            .success()
    );
    successful(command(
        &fixture,
        &server,
        &["clear", &store.id, moved.to_str().unwrap()],
    ));
    assert!(!store.directory.exists());
    assert_eq!(fs::read(&moved).unwrap(), before);
    let late = command(
        &fixture,
        &server,
        &["worker", &store.id, &worker, moved.to_str().unwrap()],
    );
    assert!(!late.status.success());
    assert_eq!(server.requests().len(), 1);
    assert_eq!(fs::read(&moved).unwrap(), before);
    assert!(!store.directory.exists());
}

#[test]
fn stopping_dead_running_worker_persists_denial_before_releasing_lease() {
    let fixture = Fixture::new();
    let server = Server::new(vec![answer("seeded")]);
    let (path, store) = seed(&fixture, &server);
    let dead = Command::new(env!("CARGO_BIN_EXE_xal-rust"))
        .arg("--version")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let pid = dead.id();
    let mut dead = dead;
    dead.wait().unwrap();
    assert!(!background::alive(pid).unwrap());
    let (mut journal, _) = xal_host::agent::Journal::resume(&path).unwrap();
    journal.append(&json!({"type":"item","item":{"type":"tool_call","callId":"unanswered","name":"write","args":{"file_path":"not-created","content":"no replay"}}})).unwrap();
    drop(journal);
    let worker = xal_services::credentials::new_id().unwrap();
    store.claim(&worker).unwrap();
    store
        .publish(&State {
            version: 1,
            app_version: "fixture".into(),
            session_id: store.id.clone(),
            session_path: path.clone(),
            cwd: fixture.cwd.clone(),
            title: None,
            log: store.directory.join("fixture.log"),
            pid,
            worker_id: worker,
            started_at: 1,
            updated_at: 1,
            status: Status::Running,
            activity: None,
            detail: None,
        })
        .unwrap();
    successful(command(&fixture, &server, &["stop", &store.id]));
    assert!(store.lease().unwrap().is_none());
    assert_eq!(store.state().unwrap().unwrap().status, Status::Stopped);
    let loaded = xal_services::sessions::load(&path).unwrap();
    assert!(
        xal_host::agent::history::pending_calls(
            &xal_host::agent::history::active(&loaded.records).unwrap()
        )
        .is_empty()
    );
    successful(command(&fixture, &server, &["attach", &store.id]));
    assert!(!store.directory.exists());
    assert!(!fixture.cwd.join("not-created").exists());
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn attach_waits_for_terminal_worker_to_release_transcript_and_lease() {
    let fixture = Fixture::new();
    let server = Server::new(vec![answer("seeded")]);
    let (path, store) = seed(&fixture, &server);
    let (journal, _) = xal_host::agent::Journal::resume(&path).unwrap();
    let worker = xal_services::credentials::new_id().unwrap();
    store.claim(&worker).unwrap();
    store
        .publish(&State {
            version: 1,
            app_version: "fixture".into(),
            session_id: store.id.clone(),
            session_path: path,
            cwd: fixture.cwd.clone(),
            title: None,
            log: store.directory.join("fixture.log"),
            pid: std::process::id(),
            worker_id: worker.clone(),
            started_at: 1,
            updated_at: 1,
            status: Status::NeedsInput,
            activity: None,
            detail: None,
        })
        .unwrap();
    thread::scope(|scope| {
        let attach = scope.spawn(|| command(&fixture, &server, &["attach", &store.id]));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !store.directory.join("attach.lock").exists() {
            assert!(Instant::now() < deadline, "attach did not claim its marker");
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(150));
        drop(journal);
        store.release(&worker).unwrap();
        let output = attach.join().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stdout).contains("needs interactive input"));
        assert!(output.stderr.is_empty());
    });
    assert!(store.state().unwrap().is_some());
    assert_eq!(server.requests().len(), 1);
}

#[cfg(unix)]
#[test]
fn worker_survives_hangup_and_death_recovery_does_not_replay_effects() {
    let fixture = Fixture::new();
    let server = Server::new(vec![
        answer("seeded"),
        call("waiting", "scheduler", json!({"duration_ms":43200000})) + &done(),
        answer("recovered"),
    ]);
    let (path, store) = seed(&fixture, &server);
    successful(command(
        &fixture,
        &server,
        &["start", path.to_str().unwrap()],
    ));
    let state = wait_state(&store, |state| state.status == Status::Running);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !xal_services::sessions::load(&path)
        .unwrap()
        .conversation
        .items
        .iter()
        .any(|item| item["type"] == "tool_call" && item["callId"] == "waiting")
    {
        assert!(Instant::now() < deadline, "pending call was not persisted");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        Command::new("kill")
            .args(["-HUP", &state.pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    thread::sleep(Duration::from_millis(150));
    assert!(background::alive(state.pid).unwrap());
    assert_eq!(store.state().unwrap().unwrap().status, Status::Running);
    assert!(xal_services::session_lock::SessionLock::acquire(&path).is_err());
    assert!(
        Command::new("kill")
            .args(["-KILL", &state.pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while background::alive(state.pid).unwrap() {
        assert!(Instant::now() < deadline, "worker was not reaped");
        thread::sleep(Duration::from_millis(10));
    }
    successful(command(&fixture, &server, &["attach", &store.id]));
    assert!(!store.directory.exists());
    assert!(
        server
            .requests()
            .last()
            .unwrap()
            .to_string()
            .contains("inspect the workspace first")
    );
}
