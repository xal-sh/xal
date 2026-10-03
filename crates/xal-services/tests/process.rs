use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use xal_services::process::{EnvironmentVariable, Process, ProcessRequest};
use xal_services::shell::{ShellExecution, ShellManager, ShellRequest};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xal-process-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Fixture {
    #[cfg(unix)]
    fn stop_detached(&self) {
        let path = self.0.join("heartbeat.pid");
        let pid = match fs::read_to_string(&path) {
            Ok(pid) => pid.parse::<i32>().unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("{error}"),
        };
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        wait_until(|| {
            #[cfg(target_os = "linux")]
            if fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit_once(") ")
                    .is_some_and(|(_, state)| state.starts_with("Z "))
            }) {
                return true;
            }
            if unsafe { libc::kill(pid, 0) } == 0 {
                return false;
            }
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            true
        });
        fs::remove_file(path).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.stop_detached();
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn environment() -> Vec<EnvironmentVariable> {
    std::env::vars()
        .filter(|(name, _)| name != "XAL_PROCESS_FIXTURE" && name != "XAL_PROCESS_PATH")
        .map(|(name, value)| EnvironmentVariable { name, value })
        .collect()
}

fn process(mode: &str, cwd: &Path) -> Process {
    let mut environment = environment();
    environment.extend([
        EnvironmentVariable {
            name: "XAL_PROCESS_FIXTURE".into(),
            value: mode.into(),
        },
        EnvironmentVariable {
            name: "XAL_PROCESS_PATH".into(),
            value: cwd.join("heartbeat").to_string_lossy().into_owned(),
        },
    ]);
    Process::spawn(ProcessRequest {
        launch: vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--exact".into(),
            "process_fixture".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ],
        cwd: cwd.to_string_lossy().into_owned(),
        environment,
        stdin: mode.ends_with("block-input"),
    })
    .unwrap()
}

#[test]
#[ignore]
fn process_fixture() {
    let mode = std::env::var("XAL_PROCESS_FIXTURE").unwrap();
    if mode == "output" {
        std::io::stdout().write_all(&vec![b'@'; 1_000_000]).unwrap();
        std::process::exit(7);
    }
    let path = PathBuf::from(std::env::var("XAL_PROCESS_PATH").unwrap());
    if mode == "stream" {
        fs::write(&path, "ready").unwrap();
        loop {
            match std::io::stdout().write_all(&[b'@'; 8192]) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                    std::thread::sleep(Duration::from_secs(60));
                }
                Err(error) => panic!("{error}"),
            }
        }
    }
    #[cfg(unix)]
    if mode.starts_with("detached") {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "process_fixture", "--ignored", "--nocapture"])
            .env(
                "XAL_PROCESS_FIXTURE",
                if mode.contains("stream") {
                    "stream"
                } else {
                    "heartbeat"
                },
            );
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        fs::write(path.with_extension("pid"), child.id().to_string()).unwrap();
        wait_until(|| path.exists());
        if mode.ends_with("root-exit") {
            std::process::exit(0);
        }
        child.wait().unwrap();
        return;
    }
    if mode == "heartbeat" {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        loop {
            file.write_all(b".").unwrap();
            file.flush().unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "process_fixture", "--ignored", "--nocapture"])
        .env("XAL_PROCESS_FIXTURE", "heartbeat")
        .spawn()
        .unwrap();
    wait_until(|| path.exists());
    if mode == "root-exit" {
        std::process::exit(0);
    }
    child.wait().unwrap();
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "process did not reach fixture checkpoint"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_process(process: &Process) -> xal_services::process::ProcessTermination {
    let mut wait = process.wait();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || sender.send(wait.compute()).unwrap());
    let result = receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    thread.join().unwrap();
    result
}

#[test]
fn process_output_status_timeout_drop_and_parent_exit_own_the_entire_tree() {
    let fixture = Fixture::new();
    let output = process("output", &fixture.0);
    assert_eq!(wait_process(&output).exit_code, Some(7));
    assert_eq!(
        output.drain().iter().filter(|byte| **byte == b'@').count(),
        1_000_000
    );
    for mode in ["timeout", "drop", "root-exit"] {
        let child = process(mode, &fixture.0);
        wait_until(|| fixture.0.join("heartbeat").exists());
        if mode == "timeout" {
            child.set_timeout(30);
        }
        if mode == "drop" {
            let mut wait = child.wait();
            drop(child);
            let (sender, receiver) = mpsc::channel();
            let thread = std::thread::spawn(move || sender.send(wait.compute()).unwrap());
            receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            thread.join().unwrap();
        } else {
            wait_process(&child);
            if mode == "timeout" {
                assert!(child.timed_out());
            }
        }
        let size = fs::metadata(fixture.0.join("heartbeat")).unwrap().len();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            fs::metadata(fixture.0.join("heartbeat")).unwrap().len(),
            size,
            "descendant survived {mode}"
        );
        fs::remove_file(fixture.0.join("heartbeat")).unwrap();
    }
    assert!(
        Process::spawn(ProcessRequest {
            launch: Vec::new(),
            cwd: fixture.0.to_string_lossy().into_owned(),
            environment: Vec::new(),
            stdin: false
        })
        .is_err()
    );
}

fn shell_request(cwd: &Path, command: &str, session: &str) -> ShellRequest {
    let shell = xal_services::shell::select().unwrap().executable;
    ShellRequest {
        session_id: session.into(),
        sandbox_id: "plain".into(),
        command: command.into(),
        cwd: cwd.to_string_lossy().into_owned(),
        persistent_launch: vec![shell.clone(), "-s".into()],
        isolated_launch: vec![shell, "-c".into(), command.into()],
        environment: environment(),
    }
}

fn shell_output(execution: &ShellExecution) -> String {
    let mut wait = execution.wait();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || sender.send(wait.compute()).unwrap());
    let status = receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    thread.join().unwrap();
    assert_eq!(status.exit_code, Some(0));
    String::from_utf8(execution.drain()).unwrap()
}

#[cfg(unix)]
#[test]
fn detached_stdin_cannot_block_a_writer_during_termination() {
    let fixture = Fixture::new();
    let child = std::sync::Arc::new(process("detached-block-input", &fixture.0));
    wait_until(|| fixture.0.join("heartbeat").exists());
    let writing = child.clone();
    let (sender, receiver) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        sender
            .send(writing.write(&vec![b'x'; 1024 * 1024]))
            .unwrap();
    });
    assert!(matches!(
        receiver.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    child.kill();
    let result = receiver.recv_timeout(Duration::from_secs(2));
    let mut wait = child.wait();
    let (sender, receiver) = mpsc::channel();
    let waiter = std::thread::spawn(move || sender.send(wait.compute()).unwrap());
    let termination = receiver.recv_timeout(Duration::from_secs(2));
    fixture.stop_detached();
    writer.join().unwrap();
    waiter.join().unwrap();
    assert!(result.unwrap().is_err());
    termination.unwrap().unwrap();
}

#[cfg(unix)]
#[test]
fn detached_pipes_do_not_block_process_wait_or_global_shell_shutdown() {
    for mode in [
        "detached-root-exit",
        "detached-timeout",
        "detached-stream-root-exit",
    ] {
        let fixture = Fixture::new();
        let child = process(mode, &fixture.0);
        wait_until(|| fixture.0.join("heartbeat").exists());
        if mode == "detached-timeout" {
            child.set_timeout(30);
        }
        let mut wait = child.wait();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || sender.send(wait.compute()).unwrap());
        let result = receiver.recv_timeout(Duration::from_secs(2));
        fixture.stop_detached();
        worker.join().unwrap();
        result.unwrap().unwrap();
        assert!(child.output_closed());
    }
    for mode in ["detached-hold", "detached-stream-hold"] {
        let fixture = Fixture::new();
        let manager = ShellManager::new();
        let mut request = shell_request(&fixture.0, "unused", "detached");
        request.persistent_launch = vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--exact".into(),
            "process_fixture".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ];
        request.environment.extend([
            EnvironmentVariable {
                name: "XAL_PROCESS_FIXTURE".into(),
                value: mode.into(),
            },
            EnvironmentVariable {
                name: "XAL_PROCESS_PATH".into(),
                value: fixture.0.join("heartbeat").to_string_lossy().into_owned(),
            },
        ]);
        let execution = manager.execute(request).unwrap();
        wait_until(|| fixture.0.join("heartbeat").exists());
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let result = runtime.block_on(async move {
                tokio::task::spawn_blocking(move || manager.shutdown_all())
                    .await
                    .unwrap()
            });
            drop(runtime);
            sender.send(result).unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        fixture.stop_detached();
        worker.join().unwrap();
        result.unwrap().unwrap();
        wait_until(|| execution.output_closed());
    }
}

#[test]
fn persistent_shell_keeps_cwd_environment_functions_and_isolates_concurrent_calls() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("nested")).unwrap();
    let manager = ShellManager::new();
    shell_output(
        &manager
            .execute(shell_request(
                &fixture.0,
                "cd nested; export XAL_SHELL_VALUE=kept; fixture_fn() { printf function; }",
                "first",
            ))
            .unwrap(),
    );
    assert_eq!(
        shell_output(
            &manager
                .execute(shell_request(
                    &fixture.0,
                    "[ \"${PWD##*/}\" = nested ] && printf \"$XAL_SHELL_VALUE:\" && fixture_fn",
                    "first"
                ))
                .unwrap()
        ),
        "kept:function"
    );
    let busy = manager
        .execute(shell_request(
            &fixture.0,
            "sleep 0.2; printf persistent",
            "first",
        ))
        .unwrap();
    let isolated = manager
        .execute(shell_request(
            &fixture.0,
            "printf \"${XAL_SHELL_VALUE-unset}\"",
            "first",
        ))
        .unwrap();
    assert_eq!(shell_output(&isolated), "unset");
    assert_eq!(shell_output(&busy), "persistent");
    assert_eq!(
        shell_output(
            &manager
                .execute(shell_request(
                    &fixture.0,
                    "printf \"${XAL_SHELL_VALUE-unset}\"",
                    "other"
                ))
                .unwrap()
        ),
        "unset"
    );
    manager.shutdown_session("first").unwrap();
    assert_eq!(
        shell_output(
            &manager
                .execute(shell_request(
                    &fixture.0,
                    "printf \"${XAL_SHELL_VALUE-unset}\"",
                    "first"
                ))
                .unwrap()
        ),
        "unset"
    );
    manager.shutdown_all().unwrap();
}
