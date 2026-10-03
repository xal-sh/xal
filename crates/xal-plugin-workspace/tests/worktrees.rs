use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use xal_host::permissions::Permissions;
use xal_host::*;
use xal_plugin_workspace::{Files, Shell, Worktrees};
use xal_services::settings::Settings;
use xal_services::worktree::*;

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
    worktrees: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "xal-worktree-tools-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        fs::create_dir_all(directory.join("repo/nested")).unwrap();
        let directory = directory.canonicalize().unwrap();
        let root = directory.join("repo");
        git(&root, &["init", "--initial-branch=main"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(
            &root,
            &[
                "config",
                "core.hooksPath",
                root.join(".git/hooks").to_str().unwrap(),
            ],
        );
        fs::write(root.join("nested/file.txt"), "base\n").unwrap();
        fs::write(root.join(".gitignore"), "*.ignored\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);
        Self {
            worktrees: directory.join("worktrees"),
            directory,
            root,
        }
    }

    async fn host(&self, mode: &str) -> Host {
        let mut host = Host::new(
            vec![
                Box::new(Worktrees::new(
                    self.directory.clone(),
                    self.worktrees.clone(),
                )),
                Box::new(Files),
                Box::new(Shell),
            ],
            Cancellation::default(),
        );
        host.permissions(
            Permissions::load(
                &Settings::parse(&JsonObject::new()).unwrap(),
                &self.directory,
                &self.root,
                mode,
            )
            .unwrap(),
        );
        host.start().await.unwrap();
        host
    }

    fn request(&self, cwd: &Path) -> WorktreeRequest {
        WorktreeRequest {
            cwd: cwd.to_str().unwrap().into(),
            worktrees_dir: self.worktrees.to_str().unwrap().into(),
            app_name: "xal".into(),
            display_name: "Xal".into(),
            marker_name: "xal-worktree.json".into(),
            name: Some("side".into()),
            worktree: None,
            force: None,
            aborted: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

fn args(value: Value) -> JsonObject {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn enter_exit_switches_effective_cwd_resets_file_and_shell_state_and_keeps_user_work() {
    let fixture = Fixture::new();
    let mut host = fixture.host("yolo").await;
    let session = host
        .session(
            "primary".into(),
            fixture.root.join("nested"),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    let other = host
        .session(
            "other".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    for (name, input, title) in [
        ("worktree_enter", json!({"name":"  purpose  "}), "purpose"),
        ("worktree_enter", json!({}), ""),
        (
            "worktree_exit",
            json!({"action":"keep"}),
            "keep current worktree",
        ),
        ("worktree_exit", json!({}), " current worktree"),
        (
            "worktree_remove",
            json!({"path":fixture.worktrees.join("side")}),
            &format!("~/{}", Path::new("worktrees").join("side").display()),
        ),
        ("worktree_remove", json!({"path":fixture.directory}), "~"),
        ("worktree_remove", json!({}), ""),
    ] {
        assert_eq!(
            host.tool_title(name, &args(input), &session).unwrap(),
            title
        );
    }
    host.tool("read", args(json!({"file_path":"file.txt"})), &session)
        .await
        .unwrap();
    host.tool(
        "bash",
        args(json!({"command":"export XAL_WORKTREE_FIXTURE=original"})),
        &session,
    )
    .await
    .unwrap();
    let entered = host
        .tool(
            "worktree_enter",
            args(json!({"name":"nested work"})),
            &session,
        )
        .await
        .unwrap();
    assert!(entered.output.contains("Entered isolated worktree"));
    let effective = host.effective_session(&session).unwrap();
    assert_ne!(effective.cwd, session.cwd);
    assert_eq!(host.effective_session(&other).unwrap().cwd, fixture.root);
    let worktree = managed_worktree_at(&fixture.request(&effective.cwd), &|| false)
        .unwrap()
        .unwrap();
    assert_eq!(effective.cwd, Path::new(&worktree.path).join("nested"));
    assert!(
        host.tool("worktree_enter", args(json!({"name":"again"})), &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("already inside")
    );
    assert!(
        host.tool(
            "write",
            args(json!({"file_path":"file.txt", "content":"must read"})),
            &session
        )
        .await
        .is_err()
    );
    let shell = host
        .tool(
            "bash",
            args(json!({"command":"printf '%s\\n' \"$PWD\" \"${XAL_WORKTREE_FIXTURE-unset}\""})),
            &session,
        )
        .await
        .unwrap();
    assert!(shell.output.contains(effective.cwd.to_str().unwrap()));
    assert!(shell.output.contains("unset"));
    host.tool("read", args(json!({"file_path":"file.txt"})), &session)
        .await
        .unwrap();
    host.tool(
        "write",
        args(json!({"file_path":"file.txt", "content":"isolated work\n"})),
        &session,
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("nested/file.txt")).unwrap(),
        "base\n"
    );
    assert!(
        host.tool(
            "worktree_remove",
            args(json!({"path":worktree.path})),
            &session
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("current session worktree")
    );
    assert!(
        host.tool("worktree_exit", args(json!({"action":"remove"})), &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("uncommitted or ignored")
    );
    assert_eq!(host.effective_session(&session).unwrap().cwd, effective.cwd);
    let kept = host
        .tool("worktree_exit", args(json!({"action":"keep"})), &session)
        .await
        .unwrap();
    assert!(kept.output.contains("Left"));
    assert_eq!(host.effective_session(&session).unwrap().cwd, session.cwd);
    assert_eq!(
        fs::read_to_string(effective.cwd.join("file.txt")).unwrap(),
        "isolated work\n"
    );
    assert!(
        managed_worktree_at(&fixture.request(&effective.cwd), &|| false)
            .unwrap()
            .is_none()
    );
    assert!(
        host.tool(
            "write",
            args(json!({"file_path":"file.txt", "content":"still must read"})),
            &session
        )
        .await
        .is_err()
    );
    host.shutdown().await;
}

#[tokio::test]
async fn clean_exit_and_other_worktree_removal_keep_branches_and_require_approval_for_force() {
    let fixture = Fixture::new();
    let mut host = fixture.host("normal").await;
    let session = host
        .session(
            "primary".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    host.tool("worktree_enter", args(json!({"name":"clean"})), &session)
        .await
        .unwrap();
    let current = host.effective_session(&session).unwrap();
    let worktree = managed_worktree_at(&fixture.request(&current.cwd), &|| false)
        .unwrap()
        .unwrap();
    let result = host
        .tool(
            "worktree_exit",
            args(json!({"action":"remove","force":true})),
            &session,
        )
        .await;
    assert!(matches!(result, Err(Error::ApprovalRequired(_))));
    assert!(Path::new(&worktree.path).is_dir());
    host.tool("worktree_exit", args(json!({"action":"remove"})), &session)
        .await
        .unwrap();
    assert_eq!(host.effective_session(&session).unwrap().cwd, fixture.root);
    assert!(!Path::new(&worktree.path).exists());
    assert_eq!(
        git(&fixture.root, &["rev-parse", &worktree.branch]),
        worktree.base_commit
    );
    let side = create_managed_worktree(&fixture.request(&fixture.root), &|| false).unwrap();
    fs::write(Path::new(&side.path).join("cache.ignored"), "preserve").unwrap();
    assert!(
        host.tool("worktree_remove", args(json!({"path":side.path})), &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("uncommitted or ignored")
    );
    assert!(matches!(
        host.tool(
            "worktree_remove",
            args(json!({"path":side.path,"force":true})),
            &session
        )
        .await,
        Err(Error::ApprovalRequired(_))
    ));
    fs::remove_file(Path::new(&side.path).join("cache.ignored")).unwrap();
    let removed = host
        .tool("worktree_remove", args(json!({"path":side.path})), &session)
        .await
        .unwrap();
    assert!(removed.output.contains("remains available"));
    assert_eq!(
        git(&fixture.root, &["rev-parse", &side.branch]),
        side.base_commit
    );
    host.shutdown().await;
}

#[tokio::test]
async fn task_read_only_invalid_and_cancelled_calls_cannot_mutate_worktrees() {
    let fixture = Fixture::new();
    let mut host = fixture.host("yolo").await;
    for (kind, read_only) in [(SessionKind::Task, false), (SessionKind::Headless, true)] {
        let session = host
            .session(
                format!("{kind:?}-{read_only}"),
                fixture.root.clone(),
                kind,
                read_only,
            )
            .unwrap();
        assert!(
            !host
                .tools(&session)
                .unwrap()
                .iter()
                .any(|tool| tool.name.starts_with("worktree_"))
        );
        assert!(matches!(
            host.tool("worktree_enter", args(json!({"name":"denied"})), &session)
                .await,
            Err(Error::Denied(_))
        ));
    }
    let session = host
        .session(
            "primary".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    for value in [
        json!({"name":" "}),
        json!({"name":"😀".repeat(41)}),
        json!({"name":"valid","unexpected":true}),
    ] {
        assert!(
            host.tool("worktree_enter", args(value), &session)
                .await
                .is_err()
        );
    }
    assert!(
        host.tool(
            "worktree_exit",
            args(json!({"action":"keep", "force":true})),
            &session
        )
        .await
        .is_err()
    );
    session.cancellation.cancel();
    assert_eq!(
        host.tool(
            "worktree_enter",
            args(json!({"name":"cancelled"})),
            &session
        )
        .await,
        Err(Error::Cancelled)
    );
    assert!(git(&fixture.root, &["branch", "--list", "xal/*"]).is_empty());
    host.shutdown().await;
}
