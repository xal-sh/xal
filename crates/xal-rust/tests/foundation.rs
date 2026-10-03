use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use xal_services::config::{Configuration, agent_home, project_root};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "xal-foundation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        let root = if cfg!(windows) {
            root
        } else {
            root.canonicalize().unwrap()
        };
        let home = root.join("home");
        let project = root.join("workspace");
        fs::create_dir(&home).unwrap();
        fs::create_dir_all(project.join(".xal")).unwrap();
        fs::create_dir(project.join("nested")).unwrap();
        fs::write(project.join(".git"), "gitdir: fixture").unwrap();
        Self {
            root,
            home,
            project,
        }
    }

    fn trust(&self) {
        fs::write(
            self.home.join("trust.json"),
            serde_json::to_vec(&[&self.project]).unwrap(),
        )
        .unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xal-rust"))
            .args(args)
            .env("XAL_HOME", &self.home)
            .current_dir(self.project.join("nested"))
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn reads_legacy_layers_only_after_exact_root_trust_without_writes() {
    let fixture = Fixture::new();
    let user = include_str!("fixtures/user-config.json");
    let project = include_str!("fixtures/project-config.json");
    fs::write(fixture.home.join("config.json"), user).unwrap();
    fs::write(fixture.project.join(".xal/config.json"), project).unwrap();
    let config =
        Configuration::load(&fixture.home, &fixture.project.join("nested/../nested")).unwrap();
    assert!(!config.trusted);
    assert_eq!(config.project_root, fixture.project);
    assert_eq!(config.values["model"], "global-model");
    fs::write(
        fixture.home.join("trust.json"),
        serde_json::to_vec(&[format!("{}/", fixture.project.display())]).unwrap(),
    )
    .unwrap();
    assert!(
        !Configuration::load(&fixture.home, &fixture.project)
            .unwrap()
            .trusted
    );
    fixture.trust();
    let config = Configuration::load(&fixture.home, &fixture.project.join("nested")).unwrap();
    assert!(config.trusted);
    assert_eq!(config.values["model"], "project-model");
    assert_eq!(
        config.values["permissions"]["deny"],
        serde_json::json!(["write"])
    );
    assert_eq!(
        config.values["permissions"]["allow"],
        serde_json::json!(["read"])
    );
    assert_eq!(config.values["pluginConfig"]["mcp"]["keep"], true);
    assert_eq!(config.values["pluginConfig"]["mcp"]["replace"], false);
    assert_eq!(
        config.values["unknown"],
        serde_json::json!({"preserved": 1})
    );
    assert_eq!(config.redaction_values().unwrap(), ["workspace"]);
    let output = fixture.run(&["config-check"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("[REDACTED]"));
    assert!(!text.contains("workspace"));
    assert!(text.contains("all core settings"));
    assert!(output.stderr.is_empty());
    assert_eq!(
        fs::read_to_string(fixture.home.join("config.json")).unwrap(),
        user
    );
    assert_eq!(
        fs::read_to_string(fixture.project.join(".xal/config.json")).unwrap(),
        project
    );
    assert_eq!(fs::read_dir(&fixture.home).unwrap().count(), 2);
}

#[test]
fn rejects_malformed_trusted_files_and_never_reads_untrusted_project_config() {
    let fixture = Fixture::new();
    fs::write(
        fixture.project.join(".xal/config.json"),
        "malformed fixture-secret",
    )
    .unwrap();
    assert!(fixture.run(&["config-check"]).status.success());
    fixture.trust();
    let output = fixture.run(&["config-check"]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("malformed"));
    assert!(!error.contains("fixture-secret"));
    for malformed in ["{}", "[1]", "null", "invalid"] {
        fs::write(fixture.home.join("trust.json"), malformed).unwrap();
        assert!(Configuration::load(&fixture.home, &fixture.project).is_err());
    }
    fs::remove_file(fixture.home.join("trust.json")).unwrap();
    for malformed in [
        "[]",
        "null",
        "invalid",
        r#"{"redaction":{"values":[1]}}"#,
        r#"{"redaction":null}"#,
    ] {
        fs::write(fixture.home.join("config.json"), malformed).unwrap();
        let output = fixture.run(&["config-check"]);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn reports_external_plugins_without_loading_them_and_keeps_lightweight_paths_independent() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        r#"{"plugins":["./do-not-load.js"]}"#,
    )
    .unwrap();
    let output = fixture.run(&["config-check"]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("external plugins are not supported")
    );
    fs::write(fixture.home.join("config.json"), "invalid").unwrap();
    for args in [&["--help"][..], &["--version"][..], &[][..]] {
        let output = fixture.run(args);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(!output.stdout.is_empty());
    }
    for args in [&["not-a-command"][..], &["config-check", "extra"][..]] {
        let output = fixture.run(args);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn empty_home_stays_empty_and_non_git_roots_use_the_working_directory() {
    let fixture = Fixture::new();
    let output = fixture.run(&["config-check"]);
    assert!(output.status.success());
    assert_eq!(fs::read_dir(&fixture.home).unwrap().count(), 0);
    fs::remove_file(fixture.project.join(".git")).unwrap();
    assert_eq!(
        project_root(&fixture.project.join("nested")).unwrap(),
        fixture.project.join("nested")
    );
    assert_eq!(
        agent_home(Some("  isolated-home  "), None).unwrap(),
        PathBuf::from("isolated-home")
    );
    assert_eq!(
        agent_home(Some(" \t"), Some(fixture.root.clone())).unwrap(),
        fixture.root.join(".xal")
    );
    assert!(agent_home(None, None).is_err());
}

#[test]
fn environment_redaction_uses_the_child_environment_without_global_mutation() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        r#"{"redaction":{"environment":["XAL_TEST_SECRET"]}}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_xal-rust"))
        .arg("config-check")
        .env("XAL_HOME", &fixture.home)
        .env("XAL_TEST_SECRET", "workspace")
        .current_dir(&fixture.project)
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("workspace"));
    assert!(text.contains("[REDACTED]"));
}

#[test]
fn host_and_storage_checks_exercise_builtins_without_writes_or_secret_output() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("credentials.json"),
        include_str!("../../xal-services/tests/fixtures/credentials.json"),
    )
    .unwrap();
    fs::write(
        fixture.home.join("config.json"),
        r#"{"redaction":{"values":["workspace"]}}"#,
    )
    .unwrap();
    let before = fs::read(fixture.home.join("credentials.json")).unwrap();
    let output = fixture.run(&["host-check"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("Local foundation diagnostics"));
    assert!(text.contains("Credential profiles: 1"));
    assert!(text.contains("[REDACTED]"));
    for secret in ["workspace", "access-secret", "refresh-secret"] {
        assert!(!text.contains(secret));
    }
    assert_eq!(
        fs::read(fixture.home.join("credentials.json")).unwrap(),
        before
    );
    let journal = fixture.root.join("session.jsonl");
    fs::write(
        &journal,
        include_str!("../../xal-services/tests/fixtures/session.jsonl"),
    )
    .unwrap();
    let before = fs::read(&journal).unwrap();
    let output = fixture.run(&["storage-check", journal.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("Session envelopes: 8")
    );
    assert_eq!(fs::read(&journal).unwrap(), before);
    assert_eq!(fs::read_dir(&fixture.home).unwrap().count(), 2);
}
