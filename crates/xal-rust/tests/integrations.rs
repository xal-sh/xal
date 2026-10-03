use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::json;

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-integrations-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        fs::create_dir_all(root.join("home/commands")).unwrap();
        fs::create_dir_all(root.join("workspace/.xal/commands")).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let cwd = root.join("workspace");
        fs::create_dir(cwd.join(".git")).unwrap();
        Self { root, home, cwd }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xal-rust"));
        command
            .args(args)
            .env("XAL_HOME", &self.home)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .current_dir(&self.cwd);
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn output(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn trust(&self) {
        fs::write(self.home.join("trust.json"), json!([self.cwd]).to_string()).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn native_commands_use_trust_precedence_and_preserve_unapproved_mcp_configuration() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("commands/inspect.md"),
        "---\ndescription: User inspection\n---\nUser $1 / $ARGUMENTS / $$\n",
    )
    .unwrap();
    fs::write(
        fixture.cwd.join(".xal/commands/inspect.md"),
        "---\ndescription: Project inspection\n---\nProject $1 / $ARGUMENTS / $$\n",
    )
    .unwrap();
    assert!(fixture.output(&["commands"]).contains("User inspection"));
    assert!(
        fixture
            .output(&["prompt", "inspect", "one", "two"])
            .contains("User one / one two / $")
    );
    fixture.trust();
    assert!(fixture.output(&["commands"]).contains("Project inspection"));
    assert!(
        fixture
            .output(&["prompt", "inspect", "one", "two"])
            .contains("Project one / one two / $")
    );
    let raw = json!({"mcpServers":{"unapproved":{"command":"must-not-launch-fixture","env":{"TOKEN":"${P04_TOKEN}"}}}}).to_string();
    fs::write(fixture.cwd.join(".mcp.json"), &raw).unwrap();
    assert!(fixture.output(&["mcp", "discover"]).contains("unapproved"));
    let imported = fixture.run(&["mcp", "import", "project", "--confirm"]);
    assert!(!imported.status.success());
    assert_eq!(
        fs::read_to_string(fixture.cwd.join(".mcp.json")).unwrap(),
        raw
    );
    assert!(!fixture.cwd.join(".xal/config.json").exists());
    let status = fixture.run(&["mcp"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(String::from_utf8_lossy(&status.stderr).contains("unapproved"));
    let failure = fixture.run(&["prompt", "unknown"]);
    assert_eq!(failure.status.code(), Some(1));
    assert!(failure.stdout.is_empty());
    assert!(!failure.stderr.is_empty());
    fs::write(fixture.home.join("config.json"), "invalid").unwrap();
    assert!(fixture.run(&["mcp", "--help"]).status.success());
    assert!(!fixture.run(&["commands"]).status.success());
}

#[test]
#[cfg(unix)]
fn mcp_startup_signals_settle_the_server_and_preserve_exit_codes() {
    use std::process::Stdio;
    use std::thread;
    use std::time::{Duration, Instant};

    for (signal, exit) in [("-INT", 130), ("-TERM", 143), ("-HUP", 129)] {
        let fixture = Fixture::new();
        fs::write(
            fixture.home.join("config.json"),
            json!({"pluginConfig":{"mcp":{"servers":{"blocked":{
                "transport":"stdio",
                "command":"/bin/sh",
                "args":["-c", "IFS= read -r request; printf '%s' \"$$\" > server.pid; printf '%s' \"$request\" > initialize.json; exec sleep 30"],
                "cwd":fixture.cwd,
                "timeoutMs":30000
            }}}}}).to_string(),
        )
        .unwrap();
        let mut child = fixture
            .command(&["mcp"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !fixture.cwd.join("initialize.json").exists() {
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("MCP initialization did not start");
            }
            assert!(child.try_wait().unwrap().is_none());
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            Command::new("/bin/kill")
                .args([signal, &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("MCP interruption did not settle");
            }
            thread::sleep(Duration::from_millis(5));
        }
        let output = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(exit), "{signal}: {stderr}");
        assert!(output.stdout.is_empty());
        assert!(stderr.contains("cancelled"), "{stderr}");
        assert!(!stderr.contains("Bootstrap"), "{stderr}");
        let request: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.cwd.join("initialize.json")).unwrap())
                .unwrap();
        assert_eq!(request["method"], "initialize");
        let pid = fs::read_to_string(fixture.cwd.join("server.pid")).unwrap();
        assert!(
            !Command::new("/bin/kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success(),
            "MCP server {pid} survived {signal}"
        );
    }
}

#[test]
fn native_workspace_paths_filter_secrets_before_the_twenty_result_bound() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        json!({"redaction":{"values":["secret-fixture"]}}).to_string(),
    )
    .unwrap();
    fs::write(fixture.cwd.join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(fixture.cwd.join("ignored.txt"), "fixture").unwrap();
    for index in 0..30 {
        fs::write(
            fixture.cwd.join(format!("a-secret-fixture-{index:02}.txt")),
            "fixture",
        )
        .unwrap();
        fs::write(
            fixture.cwd.join(format!("z-safe-{index:02}.txt")),
            "fixture",
        )
        .unwrap();
    }
    let output = fixture.output(&["workspace-paths", ".txt"]);
    assert_eq!(output.lines().count(), 20);
    assert!(output.lines().all(|path| path.starts_with("z-safe-")));
    assert!(!output.contains("secret-fixture"));
    assert!(!output.contains("ignored"));
}
