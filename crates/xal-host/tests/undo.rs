use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::json;
use xal_host::undo::{History, Scope, Shared};
use xal_host::{Error, Result};

struct Fixture {
    root: PathBuf,
    history: Shared,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-undo-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let fixture = Self {
            root,
            history: Arc::new(Mutex::new(History::default())),
        };
        fixture.git(&["init", "-q"]);
        fixture.git(&["config", "user.name", "Fixture"]);
        fixture.git(&["config", "user.email", "fixture@example.invalid"]);
        fixture.write("file.txt", "original");
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-qm", "initial"]);
        fixture
    }
    fn git(&self, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn write(&self, path: &str, text: &str) {
        std::fs::write(self.root.join(path), text).unwrap();
    }
    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }
    fn mark(&self, id: &str) {
        self.history
            .lock()
            .unwrap()
            .mark(&self.root, id.into())
            .unwrap();
    }
    fn change(&self, path: &str, text: &str, scope: Scope) {
        let capture = History::begin(
            &self.history,
            &self.root,
            "fixture",
            Some(scope),
            json!({"file_path":path}).as_object().unwrap(),
            false,
        )
        .unwrap()
        .unwrap();
        self.write(path, text);
        capture.finish().unwrap();
    }
    fn rewind(
        &self,
        id: &str,
        count: usize,
        persist: impl FnOnce(usize) -> Result<()>,
    ) -> Result<()> {
        self.history.lock().unwrap().rewind(id, count, persist)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn targeted_and_full_snapshots_restore_one_message_at_a_time_without_touching_unrelated_work() {
    let fixture = Fixture::new();
    fixture.mark("one");
    fixture.change("file.txt", "first", Scope::Path("file_path"));
    fixture.write("unrelated.txt", "user work");
    fixture.mark("two");
    fixture.change("file.txt", "second", Scope::Workspace);
    fixture
        .rewind("one", 2, |count| {
            assert_eq!(count, 1);
            Ok(())
        })
        .unwrap();
    assert_eq!(fixture.read("file.txt"), "original");
    assert_eq!(fixture.read("unrelated.txt"), "user work");
    fixture
        .history
        .lock()
        .unwrap()
        .redo("one", |_| Ok(()))
        .unwrap();
    assert_eq!(fixture.read("file.txt"), "first");
    fixture
        .history
        .lock()
        .unwrap()
        .redo("two", |_| Ok(()))
        .unwrap();
    assert_eq!(fixture.read("file.txt"), "second");
}

#[test]
fn persistence_failure_rolls_back_all_applied_snapshots_and_keeps_redo_retryable() {
    let fixture = Fixture::new();
    fixture.mark("one");
    fixture.change("file.txt", "first", Scope::Path("file_path"));
    fixture.change("new.txt", "new", Scope::Path("file_path"));
    assert!(
        fixture
            .rewind("one", 1, |_| Err(Error::Failed("disk full".into())))
            .is_err()
    );
    assert_eq!(fixture.read("file.txt"), "first");
    assert_eq!(fixture.read("new.txt"), "new");
    fixture.rewind("one", 1, |_| Ok(())).unwrap();
    assert_eq!(fixture.read("file.txt"), "original");
    assert!(!fixture.root.join("new.txt").exists());
    assert!(
        fixture
            .history
            .lock()
            .unwrap()
            .redo("one", |_| Err(Error::Failed("disk full".into())))
            .is_err()
    );
    assert_eq!(fixture.read("file.txt"), "original");
    assert!(!fixture.root.join("new.txt").exists());
    fixture
        .history
        .lock()
        .unwrap()
        .redo("one", |_| Ok(()))
        .unwrap();
    assert_eq!(fixture.read("file.txt"), "first");
    assert_eq!(fixture.read("new.txt"), "new");
}

#[test]
fn external_changes_and_resumed_history_are_never_overwritten() {
    for index in [false, true] {
        let fixture = Fixture::new();
        fixture.mark("one");
        fixture.change("file.txt", "agent", Scope::Workspace);
        fixture.write("file.txt", "user work");
        if index {
            fixture.git(&["add", "file.txt"]);
        }
        assert!(
            fixture
                .rewind("one", 1, |_| panic!("unsafe move persisted"))
                .is_err()
        );
        assert_eq!(fixture.read("file.txt"), "user work");
    }
    let fixture = Fixture::new();
    fixture
        .history
        .lock()
        .unwrap()
        .seed(&fixture.root, ["historical".into()]);
    assert!(
        fixture
            .rewind("historical", 1, |_| panic!(
                "historical code was not captured"
            ))
            .is_err()
    );
    fixture.mark("new");
    fixture.change("file.txt", "new turn", Scope::Path("file_path"));
    fixture.rewind("new", 1, |_| Ok(())).unwrap();
    assert_eq!(fixture.read("file.txt"), "original");
}

#[test]
fn background_and_uncaptured_writes_invalidate_code_history() {
    for (scope, background) in [(Some(Scope::Workspace), true), (None, false)] {
        let fixture = Fixture::new();
        fixture.mark("one");
        fixture.change("file.txt", "agent", Scope::Workspace);
        assert!(
            History::begin(
                &fixture.history,
                &fixture.root,
                "fixture",
                scope,
                &Default::default(),
                background
            )
            .unwrap()
            .is_none()
        );
        assert!(
            fixture
                .rewind("one", 1, |_| panic!("uncaptured effects persisted"))
                .is_err()
        );
        assert_eq!(fixture.read("file.txt"), "agent");
    }
}
