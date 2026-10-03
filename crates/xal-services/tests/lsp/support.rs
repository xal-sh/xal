use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;
use xal_services::lsp::{Manager, Operation, Query, ServerConfig, ServerDefinition};

pub struct Fixture {
    pub root: PathBuf,
    pub executable: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-lsp-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let executable = root.join(format!("fixture{}", std::env::consts::EXE_SUFFIX));
        let fixture = Self { root, executable };
        let source = fixture.root.join("fixture.rs");
        std::fs::write(&source, include_str!("fixture.rs")).unwrap();
        let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .args(["--edition=2024"])
            .arg(source)
            .arg("-o")
            .arg(&fixture.executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::write(fixture.root.join("source.fake"), "one\r\ntwo😀").unwrap();
        std::fs::write(fixture.root.join(".fixture-root"), "").unwrap();
        fixture
    }

    pub fn config(&self, mode: &str) -> ServerConfig {
        ServerConfig {
            id: "fixture".into(),
            command: self.executable.to_str().unwrap().into(),
            args: vec![
                mode.into(),
                self.root
                    .join(format!("{mode}.jsonl"))
                    .to_str()
                    .unwrap()
                    .into(),
            ],
            file_types: BTreeMap::from([(".fake".into(), "fixture".into())]),
            root_markers: vec![".fixture-root".into()],
            env: BTreeMap::new(),
            initialization_options: Some(
                if mode.ends_with("block-input") {
                    serde_json::json!({"fixture":"x".repeat(1024 * 1024)})
                } else {
                    serde_json::json!({"fixture":true})
                }
                .as_object()
                .unwrap()
                .clone(),
            ),
            settings: Some(
                serde_json::json!({"fixture":{"nested":42}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
            timeout_ms: 1000,
            install: None,
        }
    }

    pub fn manager(&self, mode: &str) -> Manager {
        Manager::new(
            vec![ServerDefinition::Enabled {
                server: Box::new(self.config(mode)),
            }],
            "fixture-client".into(),
            "1".into(),
        )
        .unwrap()
    }

    pub fn query(&self, operation: Operation) -> Query {
        Query {
            operation,
            file_path: "source.fake".into(),
            line: Some(2),
            column: Some(4),
            query: Some("  workspace  ".into()),
        }
    }

    pub fn messages(&self, mode: &str) -> Vec<Value> {
        match std::fs::read_to_string(self.root.join(format!("{mode}.jsonl"))) {
            Ok(text) => text
                .split_inclusive('\n')
                .filter(|line| line.ends_with('\n'))
                .map(|line| serde_json::from_str(line).unwrap())
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("{error}"),
        }
    }

    pub fn wait_for(&self, mode: &str, predicate: impl Fn(&Value) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.messages(mode).iter().any(&predicate) {
            assert!(
                Instant::now() < deadline,
                "missing fixture message for {mode}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn assert_stopped(&self, mode: &str) {
        for pid in self.messages(mode).iter().filter_map(|message| {
            message
                .get("pid")
                .or_else(|| message.get("child"))
                .and_then(Value::as_u64)
        }) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while process_running(u32::try_from(pid).unwrap()) {
                assert!(
                    Instant::now() < deadline,
                    "fixture process {pid} remains running"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(unix)]
pub fn process_running(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat)
            if stat
                .rsplit_once(") ")
                .is_some_and(|(_, state)| state.starts_with("Z ")) =>
        {
            return false;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(error) => panic!("{error}"),
    }
    if unsafe { libc::kill(i32::try_from(pid).unwrap(), 0) } == 0 {
        return true;
    }
    let error = std::io::Error::last_os_error();
    assert_eq!(error.raw_os_error(), Some(libc::ESRCH), "{error}");
    false
}

#[cfg(windows)]
fn process_running(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        assert_eq!(
            error.raw_os_error(),
            i32::try_from(ERROR_INVALID_PARAMETER).ok(),
            "{error}"
        );
        return false;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => false,
        WAIT_TIMEOUT => true,
        _ => panic!("{}", std::io::Error::last_os_error()),
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
