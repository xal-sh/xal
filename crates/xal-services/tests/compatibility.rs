use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};
use xal_services::config::{Configuration, set_trust};
use xal_services::credentials::{Change, Credential, Credentials, new_id, profile_name, update};
use xal_services::paths::Paths;
use xal_services::records::Record;
use xal_services::redactor::Redactor;
use xal_services::settings::Settings;
use xal_services::storage::{read_json, write_json};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("xal-foundation-{}", new_id().unwrap()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn key(value: &str) -> Credential {
    Credential::ApiKey { key: value.into() }
}

#[test]
fn secure_files_remain_readable_while_the_writer_is_open() {
    use std::io::Write;

    let fixture = Fixture::new();
    let path = fixture.0.join("active.jsonl");
    let mut writer = xal_services::storage::create_secure(&path).unwrap();
    writer.write_all(b"first\n").unwrap();
    writer.sync_data().unwrap();
    assert_eq!(
        xal_services::storage::read_text(&path).unwrap().as_deref(),
        Some("first\n")
    );
    #[cfg(windows)]
    {
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
    }
    writer.write_all(b"second\n").unwrap();
    writer.sync_data().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    drop(writer);
    assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\n");
}

#[test]
fn settings_schema_and_secure_round_trip_preserve_unknown_fields_and_trust() {
    let fixture = Fixture::new();
    let home = fixture.0.join("home");
    let workspace = fixture.0.join("project");
    fs::create_dir_all(workspace.join(".git")).unwrap();
    #[cfg(unix)]
    let workspace = workspace.canonicalize().unwrap();
    write_json(
        &home.join("config.json"),
        &json!({"unknown":{"keep":null},"model":"global","permissions":{"allow":["read"]}}),
    )
    .unwrap();
    write_json(
        &workspace.join(".xal/config.json"),
        &json!({"model":"local","permissions":{"deny":["write"]}}),
    )
    .unwrap();
    let before = fs::read(home.join("config.json")).unwrap();
    assert_eq!(
        Configuration::load(&home, &workspace)
            .unwrap()
            .settings
            .model
            .as_deref(),
        Some("global")
    );
    assert_eq!(fs::read(home.join("config.json")).unwrap(), before);
    set_trust(&home, &workspace, true).unwrap();
    let config = Configuration::save(
        &home,
        &workspace,
        json!({"agents":{"maxTurns":10},"contextWindows":{"p":{"m":100.0}}})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(config.settings.model.as_deref(), Some("local"));
    assert_eq!(config.settings.permissions.allow, ["read"]);
    assert_eq!(config.settings.permissions.deny, ["write"]);
    assert_eq!(config.values["unknown"]["keep"], Value::Null);
    assert_eq!(
        Configuration::load(&home, &workspace).unwrap().values,
        config.values
    );
    assert_eq!(
        read_json(&home.join("config.json")).unwrap().unwrap()["model"],
        "global"
    );
    let before = fs::read(home.join("config.json")).unwrap();
    assert!(
        Configuration::save(
            &home,
            &workspace,
            json!({"agents":{"maxTurns":0}})
                .as_object()
                .unwrap()
                .clone()
        )
        .is_err()
    );
    assert_eq!(fs::read(home.join("config.json")).unwrap(), before);
    set_trust(&home, &workspace, false).unwrap();
    assert!(!Configuration::load(&home, &workspace).unwrap().trusted);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home.join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::os::unix::fs::symlink(home.join("config.json"), home.join("link.json")).unwrap();
        assert!(write_json(&home.join("link.json"), &json!({})).is_err());
        assert!(read_json(&home.join("link.json")).is_err());
        assert_eq!(fs::read(home.join("config.json")).unwrap(), before);
    }
    for value in [
        json!({"permissions":null}),
        json!({"modes":{"custom":false}}),
        json!({"mode":"missing"}),
        json!({"goal":{"unknown":1}}),
        json!({"redaction":{"values":[1]}}),
        json!({"agents":{"maxConcurrent":9}}),
        json!({"contextWindows":{"p":{"m":1.5}}}),
        json!({"compactionLimits":{"p":[]}}),
        json!({"typesafeAI":{"enabled":true}}),
    ] {
        assert!(
            Settings::parse(value.as_object().unwrap()).is_err(),
            "{value}"
        );
    }
    assert!(Settings::parse(json!({"plugins":[1,"x"],"provider":null,"thinking":{"p":{"x":"invalid","y":"high"}},"typesafeAI":{"enabled":false}}).as_object().unwrap()).is_ok());
}

#[test]
fn credentials_legacy_wire_identity_cas_and_concurrent_updates() {
    let fixture = Fixture::new();
    let path = fixture.0.join("credentials.json");
    fs::write(&path, include_str!("fixtures/credentials.json")).unwrap();
    let loaded = Credentials::load(&path).unwrap();
    assert_eq!(loaded.profiles()[0].id, "stable-profile");
    assert!(loaded.credential("other", "stable-profile").is_err());
    assert_eq!(loaded.secrets(), ["access-secret", "refresh-secret"]);
    let cancel = AtomicBool::new(false);
    let renamed = update(
        &path,
        Change::Rename {
            id: "stable-profile".into(),
            name: "Renamed".into(),
        },
        &cancel,
    )
    .unwrap();
    assert_eq!(renamed.id, "stable-profile");
    let expected = loaded
        .credential("fixture", "stable-profile")
        .unwrap()
        .unwrap()
        .clone();
    update(
        &path,
        Change::Replace {
            provider: "fixture".into(),
            id: renamed.id.clone(),
            expected: expected.clone(),
            credential: key("replacement"),
        },
        &cancel,
    )
    .unwrap();
    let before = fs::read(&path).unwrap();
    assert!(
        update(
            &path,
            Change::Replace {
                provider: "fixture".into(),
                id: renamed.id,
                expected,
                credential: key("stale")
            },
            &cancel
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    std::thread::scope(|scope| {
        for index in 0..8 {
            let path = &path;
            scope.spawn(move || {
                update(
                    path,
                    Change::Create {
                        provider: "fixture".into(),
                        name: format!("parallel-{index}"),
                        credential: key("secret"),
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
            });
        }
    });
    assert_eq!(Credentials::load(&path).unwrap().profiles().len(), 9);
    let raw = read_json(&path).unwrap().unwrap();
    assert!(raw["profiles"]["stable-profile"].get("id").is_none());
    assert!(!fixture.0.join("credentials.json.lock").exists());
    assert!(
        update(
            &path,
            Change::Create {
                provider: "fixture".into(),
                name: "RENAMED".into(),
                credential: key("duplicate")
            },
            &cancel
        )
        .is_err()
    );
    assert!(
        update(
            &path,
            Change::Delete {
                id: "stable-profile".into()
            },
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert!(profile_name(&"🔐".repeat(41)).is_err());
    assert_eq!(profile_name("\u{feff} name \u{feff}").unwrap(), "name");
    assert!(profile_name("embedded\ncontrol").is_err());
    fs::write(&path, "{bad secret-content").unwrap();
    let before = fs::read(&path).unwrap();
    let error = update(
        &path,
        Change::Create {
            provider: "fixture".into(),
            name: "new".into(),
            credential: key("new"),
        },
        &cancel,
    )
    .unwrap_err();
    assert!(!error.to_string().contains("secret-content"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!fixture.0.join("credentials.json.lock").exists());
}

#[test]
fn legacy_directory_lock_blocks_and_cancellation_does_not_remove_another_owner() {
    let fixture = Fixture::new();
    let path = fixture.0.join("credentials.json");
    let lock = fixture.0.join("credentials.json.lock");
    fs::create_dir(&lock).unwrap();
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let update = scope.spawn(|| {
            update(
                &path,
                Change::Create {
                    provider: "p".into(),
                    name: "name".into(),
                    credential: key("secret"),
                },
                &cancel,
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert!(!path.exists());
        cancel.store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            update.join().unwrap().unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
    });
    assert!(lock.is_dir());
    fs::remove_dir(lock).unwrap();
}

#[test]
fn journal_and_paths_preserve_legacy_envelopes_opaque_replay_and_nulls() {
    for line in include_str!("fixtures/session.jsonl").lines() {
        let record = Record::parse(line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&record.encode().unwrap()).unwrap(),
            serde_json::from_str::<Value>(line).unwrap()
        );
        assert_eq!(Record::parse(&record.encode().unwrap()).unwrap(), record);
    }
    for line in [
        "{",
        "null",
        r#"{"type":"unknown"}"#,
        r#"{"type":"meta","meta":{"version":1}}"#,
        r#"{"type":"item","item":{"type":"tool_call","args":[]}}"#,
    ] {
        assert!(Record::parse(line).is_err());
    }
    let paths = Paths {
        home: PathBuf::from("home"),
    };
    let redactor = Redactor::new(vec!["secret".into()]).unwrap();
    let path = paths
        .project_sessions(std::path::Path::new("/tmp/secret"), &redactor)
        .unwrap();
    assert!(!path.to_string_lossy().contains("secret"));
    assert_ne!(
        path,
        paths
            .project_sessions(std::path::Path::new("/tmp/[REDACTED]"), &redactor)
            .unwrap()
    );
    assert_eq!(
        paths.message_history("abc"),
        PathBuf::from(
            "home/history/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.jsonl"
        )
    );
    for id in ["", ".", "..", "a/b", "a\\b", "C:escape"] {
        assert!(paths.background_session(id).is_err());
    }
}
