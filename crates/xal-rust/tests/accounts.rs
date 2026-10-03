use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};
use xal_services::{
    config::Configuration,
    credentials::{Credentials, new_id},
    storage,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("xal-accounts-{}", new_id().unwrap()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn run(&self, args: &[&str], input: &str) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_xal-rust"))
            .args(args)
            .env("XAL_HOME", &self.0)
            .env("HOME", &self.0)
            .env_remove("XAL_MODEL")
            .current_dir(&self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_account_commands_keep_legacy_syntax_identity_and_nonbillable_connections() {
    let fixture = Fixture::new();
    let connected = fixture.run(
        &["connect", "minimax", "Original", "--key-stdin"],
        "quoted-\"-key-\\\n",
    );
    assert!(
        connected.status.success(),
        "{}",
        String::from_utf8_lossy(&connected.stderr)
    );
    assert!(!String::from_utf8_lossy(&connected.stdout).contains("quoted"));
    let stored = Credentials::load(&fixture.0.join("credentials.json")).unwrap();
    let id = stored.profiles()[0].id.clone();
    assert!(
        fixture
            .run(&["profiles", "rename", "Original", "Renamed"], "")
            .status
            .success()
    );
    let stored = Credentials::load(&fixture.0.join("credentials.json")).unwrap();
    assert_eq!(stored.profiles()[0].id, id);
    assert_eq!(stored.profiles()[0].name, "Renamed");
    let models = fixture.run(&["models", "minimax"], "");
    assert!(models.status.success());
    let models: Value = serde_json::from_slice(&models.stdout).unwrap();
    assert_eq!(models["catalogs"].as_array().unwrap().len(), 1);
    assert_eq!(models["catalogs"][0]["catalog"]["source"], "bundled");
    assert!(
        !fixture
            .run(&["models", "minimax", "unexpected"], "")
            .status
            .success()
    );
    let mut raw = storage::read_json(&fixture.0.join("credentials.json"))
        .unwrap()
        .unwrap();
    raw["profiles"]["a"] = json!({"name":"Zulu","provider":"openai","credential":{"type":"api_key","key":"other-fixture-key"}});
    raw["profiles"]["z"] = json!({"name":"Alpha","provider":"anthropic","credential":{"type":"api_key","key":"another-fixture-key"}});
    storage::write_json(&fixture.0.join("credentials.json"), &raw).unwrap();
    assert!(fixture.run(&["logout", "Renamed"], "").status.success());
    let configuration = Configuration::load(&fixture.0, &fixture.0).unwrap();
    let stored = Credentials::load(&fixture.0.join("credentials.json")).unwrap();
    let profile =
        xal_providers::profiles::select(&configuration.settings, &stored, None, None).unwrap();
    assert_eq!(profile.provider, "anthropic");
    assert_eq!(profile.id, "z");
    assert!(
        fixture
            .run(&["profiles", "rename", "Alpha", "Éclair"], "")
            .status
            .success()
    );
    let stored = Credentials::load(&fixture.0.join("credentials.json")).unwrap();
    assert_eq!(
        xal_providers::profiles::select(&configuration.settings, &stored, None, None)
            .unwrap()
            .id,
        "z"
    );
}

#[test]
fn native_typesafe_settings_do_not_switch_the_harness_and_remember_the_connection() {
    let fixture = Fixture::new();
    storage::write_json(&fixture.0.join("credentials.json"),&json!({"profiles":{"decision":{"name":"Decision","provider":"typesafe","credential":{"type":"api_key","key":"fixture-typesafe"}},"text":{"name":"Text","provider":"minimax","credential":{"type":"api_key","key":"fixture-text"}}}})).unwrap();
    storage::write_json(
        &fixture.0.join("config.json"),
        &json!({"provider":"minimax","profile":"text","model":"MiniMax-M2.7"}),
    )
    .unwrap();
    for args in [
        vec!["typesafe", "on", "--connection", "Decision"],
        vec!["typesafe", "off"],
        vec!["typesafe", "on"],
    ] {
        let output = fixture.run(&args, "");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let settings = storage::read_json(&fixture.0.join("config.json"))
        .unwrap()
        .unwrap();
    assert_eq!(settings["profile"], "text");
    assert_eq!(settings["typesafeAI"]["profile"], "decision");
    assert_eq!(settings["typesafeAI"]["enabled"], true);
}
