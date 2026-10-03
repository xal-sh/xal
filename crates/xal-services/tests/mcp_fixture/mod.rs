use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use xal_services::mcp::ServerConfig;

pub struct Fixture {
    pub root: PathBuf,
    pub executable: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-mcp-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join(if cfg!(windows) {
            "mcp-fixture.exe"
        } else {
            "mcp-fixture"
        });
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("xal-services/tests/mcp_fixture/server.rs");
        let output = std::process::Command::new("rustc")
            .args(["--edition=2024", "-o"])
            .arg(&executable)
            .arg(source)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self { root, executable }
    }

    pub fn config(&self, id: &str, mode: &str, timeout_ms: u64) -> ServerConfig {
        ServerConfig::Stdio {
            id: id.into(),
            enabled: true,
            timeout_ms,
            command: self.executable.to_str().unwrap().into(),
            args: Vec::new(),
            cwd: Some(self.root.clone()),
            env: HashMap::from([
                ("MCP_MODE".into(), mode.into()),
                (
                    "MCP_PID_PATH".into(),
                    self.root.join(format!("{id}.pid")).to_str().unwrap().into(),
                ),
                (
                    "MCP_CHILD_PATH".into(),
                    self.root
                        .join(format!("{id}.child"))
                        .to_str()
                        .unwrap()
                        .into(),
                ),
                (
                    "MCP_CANCEL_PATH".into(),
                    self.root
                        .join(format!("{id}.cancel"))
                        .to_str()
                        .unwrap()
                        .into(),
                ),
            ]),
        }
    }

    pub async fn wait_file(&self, path: &str) -> String {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(self.root.join(path)) {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    #[cfg(unix)]
    pub async fn assert_stopped(&self, id: &str) {
        for suffix in ["pid", "child"] {
            let pid: i32 = self
                .wait_file(&format!("{id}.{suffix}"))
                .await
                .parse()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if unsafe { libc::kill(pid, 0) } != 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("fixture process {pid} ({id}.{suffix}) survived shutdown"));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

pub fn flag() -> std::sync::Arc<AtomicBool> {
    std::sync::Arc::new(AtomicBool::new(false))
}

pub async fn cancel_soon(flag: &AtomicBool) {
    tokio::time::sleep(Duration::from_millis(80)).await;
    flag.store(true, Ordering::Relaxed);
}
