use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use serde_json::json;
use xal_services::{
    context_sources::{instructions, review, skills, templates},
    credentials::new_id,
    memory::{Protection, Store},
    redactor::Redactor,
    skill, storage,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("xal-context-{}", new_id().unwrap()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn write(&self, path: &str, content: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
    fn package(&self, root: &str, name: &str, description: &str, body: &str) -> PathBuf {
        self.write(
            &format!("{root}/{name}/SKILL.md"),
            &format!("---\ndescription: {description}\n---\n{body}"),
        )
    }
    fn git(&self, args: &[&str]) -> String {
        let output = xal_services::git::run_git(
            self.0.to_str().unwrap(),
            &args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            output.exit_code,
            0,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim_end().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn instructions_prioritize_nearest_file_with_utf8_budget_and_hierarchy() {
    let fixture = Fixture::new();
    fixture.write(".git", "gitdir: fixture");
    fixture.write("AGENTS.md", "outer");
    fixture.write("nested/AGENTS.md", "ééé");
    fs::create_dir_all(fixture.0.join("nested/child")).unwrap();
    let result =
        instructions::load(&fixture.0.join("nested/child"), 5, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.sources.len(), 1);
    assert_eq!(result.sources[0].content, "éé");
    assert!(result.sources[0].truncated);
    assert_eq!(result.skipped, [fixture.0.join("AGENTS.md")]);
    assert!(
        result
            .render()
            .contains("Omitted at the configured byte budget: AGENTS.md")
    );
    let result = instructions::load(
        &fixture.0.join("nested/child"),
        100,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(result.sources[0].content, "outer");
    assert_eq!(result.sources[1].content, "ééé");
    assert!(instructions::max_bytes(json!({"maxBytes": 0}).as_object().unwrap()).is_err());
    assert!(instructions::max_bytes(json!({"maxBytes": 1.5}).as_object().unwrap()).is_err());
    assert_eq!(
        instructions::max_bytes(json!({"maxBytes": 32768.0}).as_object().unwrap()).unwrap(),
        32768
    );
    assert_eq!(
        instructions::max_bytes(json!({}).as_object().unwrap()).unwrap(),
        32768
    );
    assert!(instructions::load(&fixture.0, 100, &AtomicBool::new(true)).is_err());
}

#[test]
fn markdown_command_precedence_frontmatter_and_literal_placeholders() {
    let fixture = Fixture::new();
    fixture.write("user/audit.md", "user");
    fixture.write("project/audit.md", "\u{feff}---\r\ndescription: 'Review: changes'\r\nargument-hint: \"<base> [focus]\"\r\n---\r\n$1 / $2 / $3 / $ARGUMENTS / $$1 / $0 / $9999999999999999999999999999");
    let loaded = templates::load(
        &[fixture.0.join("user"), fixture.0.join("project")],
        &AtomicBool::new(false),
    )
    .unwrap();
    let template = &loaded["audit"];
    assert_eq!(template.description, "Review: changes");
    assert_eq!(template.argument_hint.as_deref(), Some("<base> [focus]"));
    assert_eq!(
        template.expand(&["main".into(), "$HOME".into()]),
        "main / $HOME /  / main $HOME / $1 / $0 / "
    );
    for content in [
        "---\nunknown: value\n---\nbody",
        "---\ndescription: x\ndescription: y\n---\nbody",
        "---\ndescription: unclosed",
        "  ",
    ] {
        assert!(templates::parse(Path::new("audit.md"), "audit", content).is_err());
    }
    assert!(templates::parse(Path::new("Bad.md"), "Bad", "body").is_err());
    assert!(templates::load(&[fixture.0.join("user")], &AtomicBool::new(true)).is_err());
}

#[test]
fn skill_precedence_yaml_repairs_warnings_catalog_and_verbatim_invocation() {
    let fixture = Fixture::new();
    fixture.package("user/.agents/skills", "audit", "first", "user first");
    fixture.package("home/skills", "audit", "second", "user second");
    fixture.package("project/.agents/skills", "audit", "third", "project first");
    fixture.package(
        "project/.xal/skills",
        "audit",
        "Cut a release (Swift app): pick a version",
        "project second",
    );
    fixture.write("project/.xal/skills/audit/refs/steps.md", "step one");
    fixture.write(
        "home/skills/broken/SKILL.md",
        "---\ndescription: \"unterminated\n---",
    );
    fixture.write(
        "home/skills/long/SKILL.md",
        &format!("---\ndescription: {}\n---", "x".repeat(200)),
    );
    fixture.write("home/skills/display/SKILL.md", "---\nname: Display   Name\ndescription: Multiple\n  words\nmetadata:\n  notes: |-\n    Keep this: unchanged\ntags: [next,@release]\n---");
    let roots = |trusted| {
        skills::roots(
            &fixture.0.join("home"),
            &fixture.0.join("user"),
            &fixture.0.join("project"),
            trusted,
        )
    };
    let untrusted = skills::load(&roots(false), &AtomicBool::new(false)).unwrap();
    assert_eq!(untrusted.skills["audit"].body, "user second");
    let catalog = skills::load(&roots(true), &AtomicBool::new(false)).unwrap();
    assert_eq!(catalog.skills["audit"].body, "project second");
    assert_eq!(catalog.skills["Display Name"].description, "Multiple words");
    assert_eq!(catalog.warnings.len(), 1);
    assert!(
        catalog
            .prompt()
            .contains("Cut a release (Swift app): pick a version")
    );
    assert!(!catalog.prompt().contains(&"x".repeat(200)));
    assert!(
        catalog
            .expand("inline $audit", &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert!(
        catalog
            .expand(" $audit", &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert!(
        catalog
            .expand("$unknown", &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    let input = "$audit  α $HOME $(printf unsafe) $1";
    let expanded = catalog
        .expand(input, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    let args = " α $HOME $(printf unsafe) $1";
    assert!(expanded.contains(&format!("User input ({} UTF-8 bytes):\n{args}", args.len())));
    assert!(expanded.contains("- refs/steps.md"));
    let refs = skills::references("😀 $audit then $unknown", &catalog);
    assert_eq!(
        refs[0],
        skills::Reference {
            name: "audit".into(),
            start: 3,
            end: 9
        }
    );
    assert_eq!(skills::query("😀 $au", 6).unwrap().query, "au");
    assert!(skills::query("$audit next", 11).is_none());
    assert!(skills::load(&roots(true), &AtomicBool::new(true)).is_err());
    fixture.write(
        "home/skills/duplicate/SKILL.md",
        "---\nname: audit\ndescription: duplicate\n---",
    );
    assert!(
        skills::load(&roots(false), &AtomicBool::new(false))
            .unwrap_err()
            .to_string()
            .contains("duplicate skill name")
    );
}

#[test]
fn skill_supporting_resources_are_bounded_utf8_and_cannot_escape() {
    let fixture = Fixture::new();
    let path = fixture.package("skills", "audit", "audit", "instructions");
    let skill = skills::parse(
        &path,
        &fs::read_to_string(&path).unwrap(),
        skills::Source::User,
    )
    .unwrap();
    fixture.write("skills/audit/refs/good.md", "allowed");
    fixture.write("outside.txt", "private");
    fixture.write("skills/audit/binary", "a\0b");
    fixture.write("skills/audit/large", &"x".repeat(50_001));
    fs::write(fixture.0.join("skills/audit/invalid"), [0xff]).unwrap();
    assert_eq!(
        skill::execute(
            &skill.request(Some("refs/good.md".into())),
            &AtomicBool::new(false)
        )
        .unwrap(),
        "allowed"
    );
    for (path, message) in [
        (
            "../../outside.txt",
            "path must stay inside the skill directory",
        ),
        ("", "path must be relative to the skill directory"),
        ("binary", "skill file is binary: binary"),
        ("large", "skill file exceeds 50000 bytes: large"),
        ("invalid", "skill file is not valid UTF-8: invalid"),
        ("missing", "skill file not found: missing"),
        ("refs", "skill path is not a file: refs"),
    ] {
        assert_eq!(
            skill::execute(&skill.request(Some(path.into())), &AtomicBool::new(false))
                .unwrap_err()
                .to_string(),
            message
        );
    }
    assert!(
        skill::execute(
            &skill.request(Some(
                fixture.0.join("outside.txt").to_string_lossy().into_owned()
            )),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(skill::execute(&skill.request(None), &AtomicBool::new(true)).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fixture.0.join("outside.txt"),
            fixture.0.join("skills/audit/escape"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&fixture.0, fixture.0.join("skills/audit/escape-dir")).unwrap();
        std::os::unix::fs::symlink(
            fixture.0.join("skills/audit"),
            fixture.0.join("skills/audit/loop"),
        )
        .unwrap();
        for path in ["escape", "escape-dir/outside.txt"] {
            assert!(
                skill::execute(&skill.request(Some(path.into())), &AtomicBool::new(false)).is_err()
            );
        }
        let files = skill::supporting_files(&skill.directory, &skill.path, &AtomicBool::new(false))
            .unwrap();
        assert!(
            !files
                .iter()
                .any(|file| file.starts_with("escape") || file.starts_with("loop"))
        );
    }
}

#[test]
fn global_memory_cas_security_redaction_and_cancellation_release_locks() {
    let fixture = Fixture::new();
    let path = fixture.0.join("MEMORY.md");
    let store = Store::new(path.clone());
    let second = Store::new(path.clone());
    let protection = Protection::Secrets(&[]);
    let flag = AtomicBool::new(false);
    let empty = store.load(protection, &flag).unwrap();
    let first = store
        .replace("durable".into(), &empty.revision, protection, &flag)
        .unwrap();
    assert_eq!(
        second.load(protection, &flag).unwrap().revision,
        first.revision
    );
    second
        .replace("other".into(), &first.revision, protection, &flag)
        .unwrap();
    assert!(
        store
            .replace("stale".into(), &first.revision, protection, &flag)
            .is_err()
    );
    assert_eq!(store.prompt_content(protection).unwrap(), "other");
    assert!(!fixture.0.join("MEMORY.md.lock").exists());
    let current = store.load(protection, &flag).unwrap();
    for content in ["TOKEN".into(), "x".repeat(16 * 1024 + 1)] {
        assert!(
            store
                .replace(
                    content,
                    &current.revision,
                    Protection::Secrets(&["TOKEN".into()]),
                    &flag
                )
                .is_err()
        );
    }
    assert!(
        store
            .replace(
                "cancelled".into(),
                &current.revision,
                protection,
                &AtomicBool::new(true)
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "other");
    let redactor = Redactor::new(vec![]).unwrap();
    assert_eq!(
        store
            .prompt_content(Protection::Redactor(&redactor))
            .unwrap(),
        "other"
    );
    redactor.protect(vec!["other".into()]).unwrap();
    assert!(
        store
            .prompt_content(Protection::Redactor(&redactor))
            .is_err()
    );
    let lock = fixture.0.join("MEMORY.md.lock");
    let owner = storage::create_secure(&lock).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let child_flag = cancelled.clone();
    let worker = std::thread::spawn(move || {
        second.replace(
            "late".into(),
            &current.revision,
            Protection::Secrets(&[]),
            &child_flag,
        )
    });
    std::thread::sleep(Duration::from_millis(40));
    cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        worker.join().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    assert!(lock.exists());
    drop(owner);
    fs::remove_file(lock).unwrap();
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            store
                .load(protection, &flag)
                .unwrap_err()
                .to_string()
                .contains("0600")
        );
        fs::remove_file(&path).unwrap();
        fixture.write("outside", "not memory");
        symlink(fixture.0.join("outside"), &path).unwrap();
        assert!(store.load(protection, &flag).is_err());
        assert!(
            store
                .replace("overwrite".into(), &empty.revision, protection, &flag)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("outside")).unwrap(),
            "not memory"
        );
    }
}

#[test]
fn review_working_tree_base_errors_and_cancellation_use_normal_git() {
    let fixture = Fixture::new();
    fixture.git(&["init", "--initial-branch=main"]);
    fixture.git(&["config", "user.name", "Fixture"]);
    fixture.git(&["config", "user.email", "fixture@example.invalid"]);
    fixture.write("tracked.txt", "before\n");
    fixture.git(&["add", "--", "tracked.txt"]);
    fixture.git(&["commit", "-m", "initial"]);
    let flag = AtomicBool::new(false);
    assert!(review::scope(&fixture.0, None, &flag).unwrap().is_none());
    assert!(
        review::scope(&fixture.0, Some("main"), &flag)
            .unwrap()
            .is_none()
    );
    fixture.git(&["checkout", "-b", "topic"]);
    fixture.write("tracked.txt", "committed\n");
    fixture.git(&["commit", "-am", "topic"]);
    fixture.write("tracked.txt", "unstaged\n");
    fixture.write("untracked.txt", "new\n");
    let prompt = review::scope(&fixture.0, None, &flag)
        .unwrap()
        .unwrap()
        .prompt();
    assert!(prompt.contains("`git diff --cached --no-ext-diff --find-renames --`"));
    assert!(prompt.contains(" M tracked.txt"));
    assert!(prompt.contains("?? untracked.txt"));
    assert!(!prompt.contains("review_diff"));
    let base = review::scope(&fixture.0, Some("main"), &flag)
        .unwrap()
        .unwrap();
    assert!(base.description.contains("merge base with main"));
    assert!(base.context.contains(&fixture.git(&["rev-parse", "main"])));
    assert!(review::scope(&fixture.0, Some("does-not-exist"), &flag).is_err());
    assert!(review::scope(&fixture.0, Some("--help"), &flag).is_err());
    assert_eq!(
        review::scope(&fixture.0, None, &AtomicBool::new(true))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::Interrupted
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("tracked.txt")).unwrap(),
        "unstaged\n"
    );
    assert!(!fixture.0.join(".git/index.lock").exists());
}

#[cfg(unix)]
#[test]
fn review_cancellation_terminates_a_running_local_executable() {
    use std::os::unix::fs::PermissionsExt;
    if let Some(root) = std::env::var_os("XAL_CONTEXT_REVIEW_FIXTURE") {
        let root = PathBuf::from(root);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_flag = cancelled.clone();
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || review::scope(&worker_root, None, &worker_flag));
        let started = std::time::Instant::now();
        while !root.join("ready").exists() && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        cancelled.store(true, Ordering::Relaxed);
        let result = worker.join().unwrap();
        assert!(root.join("ready").exists(), "{result:?}");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = fs::read_to_string(root.join("ready"))
            .unwrap()
            .parse()
            .unwrap();
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        return;
    }
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join(".git")).unwrap();
    let executable = fixture.write(
        "git",
        "#!/bin/sh\ncd \"$2\" || exit 1\nprintf '%s' \"$$\" > ready\nexec /bin/sleep 30\n",
    );
    fs::set_permissions(executable, fs::Permissions::from_mode(0o700)).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "review_cancellation_terminates_a_running_local_executable",
            "--nocapture",
        ])
        .env("XAL_CONTEXT_REVIEW_FIXTURE", &fixture.0)
        .env("PATH", &fixture.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.0.join(".git/index.lock").exists());
}
