use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use xal_host::*;
use xal_plugin_context::*;
use xal_services::{config, credentials::new_id, redactor::Redactor};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
    user: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("xal-context-plugin-{}", new_id().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let value = Self {
            home: root.join("home"),
            project: root.join("project"),
            user: root.join("user"),
            root,
        };
        for path in [&value.home, &value.project, &value.user] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir(value.project.join(".git")).unwrap();
        value
    }
    fn write(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn session(&self, host: &Host, kind: SessionKind, read_only: bool) -> Session {
        host.session("fixture".into(), self.project.clone(), kind, read_only)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Allow;
impl Plugin for Allow {
    fn name(&self) -> &str {
        "fixture"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        registration.policy(
            "fixture_allow",
            Box::new(|_, _| Box::pin(async { Ok(PolicyDecision::Allow) })),
        )?;
        registration.command("reserved", "fixture", |_, _| Ok("reserved".into()))?;
        registration.tool("switch", Tool {
            title: None,
            description: "fixture".into(), parameters: serde_json::from_value(json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false})).unwrap(),
            effects: Effects::write, concurrency: None, permission_subject: None, redact: None, available: Box::new(|_| Ok(true)),
            run: Box::new(|args, context| Box::pin(async move { context.change_workspace(PathBuf::from(args["path"].as_str().unwrap()))?; Ok(ToolResult { output: "switched".into() }) })),
        })
    }
}

async fn prompt(host: &Host, session: &Session, text: &str) -> Result<String> {
    let HookInput::Prompt { text } = host
        .hook(HookInput::Prompt { text: text.into() }, session)
        .await?
    else {
        panic!("prompt hook type");
    };
    Ok(text)
}

#[tokio::test]
async fn trust_invocations_and_workspace_switch_refresh_session_sources() {
    let fixture = Fixture::new();
    fixture.write("project/AGENTS.md", "project guidance");
    fixture.write("home/commands/audit.md", "user $ARGUMENTS");
    fixture.write("project/.xal/commands/audit.md", "project $1 $$HOME");
    fixture.write(
        "home/skills/audit/SKILL.md",
        "---\ndescription: User audit\n---\nuser instructions",
    );
    fixture.write(
        "project/.xal/skills/audit/SKILL.md",
        "---\ndescription: Project audit\n---\nproject instructions",
    );
    fixture.write("home/skills/broken/SKILL.md", "bad");
    let skills = Skills::new(
        fixture.home.clone(),
        fixture.user.clone(),
        fixture.project.clone(),
    );
    let service = skills.service();
    let mut host = Host::new(
        vec![
            Box::new(Instructions::new(
                fixture.home.clone(),
                fixture.project.clone(),
            )),
            Box::new(PromptCommands::new(
                fixture.home.clone(),
                fixture.project.clone(),
            )),
            Box::new(skills),
            Box::new(Allow),
        ],
        Cancellation::default(),
    );
    host.start().await.unwrap();
    let session = fixture.session(&host, SessionKind::Headless, false);
    assert_eq!(
        prompt(&host, &session, "/audit one two").await.unwrap(),
        "user one two"
    );
    assert!(
        !host
            .session_prompts(&session)
            .unwrap()
            .join("\n")
            .contains("project guidance")
    );
    assert_eq!(service.warnings(&fixture.project).unwrap().len(), 1);
    let prompts = host.session_prompts(&session).unwrap().join("\n");
    assert!(prompts.contains("Skill discovery warnings follow"));
    assert!(prompts.contains(&service.warnings(&fixture.project).unwrap()[0]));
    assert!(
        prompt(&host, &session, "$audit input")
            .await
            .unwrap()
            .contains("user instructions")
    );
    config::set_trust(&fixture.home, &fixture.project, true).unwrap();
    assert_eq!(
        prompt(&host, &session, "/audit one two").await.unwrap(),
        "project one $HOME"
    );
    assert!(
        host.session_prompts(&session)
            .unwrap()
            .join("\n")
            .contains("project guidance")
    );
    assert!(
        prompt(&host, &session, "$audit  $HOME")
            .await
            .unwrap()
            .contains("project instructions")
    );
    assert_eq!(
        prompt(&host, &session, "inline $audit").await.unwrap(),
        "inline $audit"
    );
    let result = host
        .tool(
            "skill",
            json!({"name":"audit"}).as_object().unwrap().clone(),
            &session,
        )
        .await
        .unwrap();
    assert!(result.output.contains("project instructions"));
    for (args, title) in [
        (json!({}), ""),
        (json!({"name":"audit"}), "audit"),
        (
            json!({"name":"audit","path":"reference.md"}),
            "audit/reference.md",
        ),
        (json!({"name":false,"path":""}), ""),
    ] {
        assert_eq!(
            host.tool_title("skill", args.as_object().unwrap(), &session)
                .unwrap(),
            title
        );
    }
    assert_eq!(
        host.render(
            "skill",
            UiContribution::Tool {
                name: "skill".into(),
                output: result.output.clone()
            },
            &session
        )
        .await
        .unwrap(),
        result.output
    );
    assert!(
        host.tool(
            "skill",
            json!({"name":"unknown"}).as_object().unwrap().clone(),
            &session
        )
        .await
        .is_err()
    );
    fixture.write("second/.git/fixture", "git marker");
    fixture.write("second/AGENTS.md", "second guidance");
    fixture.write(
        "second/.xal/skills/audit/SKILL.md",
        "---\ndescription: Second audit\n---\nsecond instructions",
    );
    fixture.write("second/.xal/commands/new-command.md", "new $1");
    let second = fixture.root.join("second").canonicalize().unwrap();
    config::set_trust(&fixture.home, &second, true).unwrap();
    host.tool(
        "switch",
        json!({"path":second}).as_object().unwrap().clone(),
        &session,
    )
    .await
    .unwrap();
    let prompts = host.session_prompts(&session).unwrap().join("\n");
    assert!(prompts.contains("second guidance"), "{prompts}");
    assert!(!prompts.contains("project guidance"));
    assert!(prompts.contains("Second audit"));
    let other = host
        .session(
            "other".into(),
            fixture.project.clone(),
            SessionKind::Task,
            false,
        )
        .unwrap();
    assert!(
        host.session_prompts(&other)
            .unwrap()
            .join("\n")
            .contains("project guidance")
    );
    host.dispose_session(&other).await.unwrap();
    assert_eq!(
        prompt(&host, &session, "/new-command argument")
            .await
            .unwrap(),
        "new argument"
    );
    fixture.write("second/.xal/commands/reserved.md", "must not override");
    assert!(
        prompt(&host, &session, "/reserved")
            .await
            .unwrap_err()
            .to_string()
            .contains("already registered")
    );
    fixture.write("project/AGENTS.md", "revised guidance");
    fixture.write(
        "project/.xal/skills/audit/SKILL.md",
        "---\ndescription: Revised audit\n---\nrevised instructions",
    );
    host.tool(
        "switch",
        json!({"path":fixture.project}).as_object().unwrap().clone(),
        &session,
    )
    .await
    .unwrap();
    let prompts = host.session_prompts(&session).unwrap().join("\n");
    assert!(prompts.contains("revised guidance"), "{prompts}");
    assert!(prompts.contains("Revised audit"), "{prompts}");
    assert!(!prompts.contains("project guidance"));
    assert!(!prompts.contains("Project audit"));
    config::set_trust(&fixture.home, &second, false).unwrap();
    host.tool(
        "switch",
        json!({"path":second}).as_object().unwrap().clone(),
        &session,
    )
    .await
    .unwrap();
    assert!(
        !host
            .session_prompts(&session)
            .unwrap()
            .join("\n")
            .contains("second guidance")
    );
    assert!(
        !host
            .session_prompts(&session)
            .unwrap()
            .join("\n")
            .contains("Second audit")
    );
    host.shutdown().await;
    assert!(host.failures().is_empty());
}

#[tokio::test]
async fn command_collisions_fail_registration_and_review_hooks_preserve_errors() {
    let fixture = Fixture::new();
    fixture.write("home/commands/review.md", "custom review");
    let mut host = Host::new(
        vec![
            Box::new(PromptCommands::new(
                fixture.home.clone(),
                fixture.project.clone(),
            )),
            Box::new(CodeReview::new(fixture.project.clone())),
        ],
        Cancellation::default(),
    );
    assert!(host.start().await.is_err());
    host.shutdown().await;
    let mut host = Host::new(
        vec![Box::new(CodeReview::new(fixture.project.clone()))],
        Cancellation::default(),
    );
    host.start().await.unwrap();
    let session = fixture.session(&host, SessionKind::Headless, false);
    assert!(
        prompt(&host, &session, "/review one two")
            .await
            .unwrap_err()
            .to_string()
            .contains("usage: /review [base]")
    );
    assert!(
        prompt(&host, &session, "/review")
            .await
            .unwrap_err()
            .to_string()
            .contains("git status")
    );
    assert_eq!(
        prompt(&host, &session, "inline /review").await.unwrap(),
        "inline /review"
    );
    host.shutdown().await;
    assert!(host.failures().is_empty());
}

#[tokio::test]
async fn memory_primary_task_read_only_secret_and_cancellation_gates() {
    let fixture = Fixture::new();
    let redactor = Arc::new(Redactor::new(vec!["TOKEN".into()]).unwrap());
    let mut host = Host::new(
        vec![Box::new(Memory::new(
            fixture.home.join("MEMORY.md"),
            redactor.clone(),
        ))],
        Cancellation::default(),
    );
    host.output_policy(redactor.clone(), fixture.home.join("artifacts"));
    host.start().await.unwrap();
    let session = fixture.session(&host, SessionKind::Headless, false);
    for (args, title) in [
        (json!({}), "Global memory"),
        (json!({"operation":false}), "Global memory"),
        (json!({"operation":"read"}), "Read global memory"),
        (json!({"operation":"replace"}), "Replace global memory"),
        (json!({"operation":"clear"}), "Clear global memory"),
    ] {
        assert_eq!(
            host.tool_title("memory", args.as_object().unwrap(), &session)
                .unwrap(),
            title
        );
    }
    let output = host
        .tool(
            "memory",
            json!({"operation":"read"}).as_object().unwrap().clone(),
            &session,
        )
        .await
        .unwrap()
        .output;
    let snapshot: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(
        host.render(
            "memory",
            UiContribution::Tool {
                name: "memory".into(),
                output: "TOKEN".into()
            },
            &session
        )
        .await
        .unwrap(),
        "[REDACTED]"
    );
    assert!(
        host.render(
            "memory",
            UiContribution::Text {
                text: "invalid".into()
            },
            &session
        )
        .await
        .is_err()
    );
    for content in ["TOKEN", "  "] {
        assert!(
            host.tool(
                "memory",
                json!({"operation":"replace","revision":snapshot["revision"],"content":content})
                    .as_object()
                    .unwrap()
                    .clone(),
                &session
            )
            .await
            .is_err()
        );
    }
    host.tool(
        "memory",
        json!({"operation":"replace","revision":format!(" {} ", snapshot["revision"].as_str().unwrap()),"content":"remembered"})
            .as_object()
            .unwrap()
            .clone(),
        &session,
    )
    .await
    .unwrap();
    assert!(
        host.session_prompts(&session)
            .unwrap()
            .join("\n")
            .contains("remembered")
    );
    assert!(
        host.tool(
            "memory",
            json!({"operation":"clear","revision":snapshot["revision"]})
                .as_object()
                .unwrap()
                .clone(),
            &session
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("changed since")
    );
    let task = Session {
        kind: SessionKind::Task,
        ..session.clone()
    };
    assert!(host.tools(&task).unwrap().is_empty());
    assert!(
        host.session_prompts(&task)
            .unwrap()
            .iter()
            .all(String::is_empty)
    );
    assert!(matches!(
        host.tool(
            "memory",
            json!({"operation":"read"}).as_object().unwrap().clone(),
            &task
        )
        .await,
        Err(Error::Denied(_))
    ));
    let read_only = Session {
        read_only: true,
        ..session.clone()
    };
    let output = host
        .tool(
            "memory",
            json!({"operation":"read"}).as_object().unwrap().clone(),
            &read_only,
        )
        .await
        .unwrap()
        .output;
    let current: Value = serde_json::from_str(&output).unwrap();
    assert!(matches!(
        host.tool(
            "memory",
            json!({"operation":"clear","revision":current["revision"]})
                .as_object()
                .unwrap()
                .clone(),
            &read_only
        )
        .await,
        Err(Error::Denied(_))
    ));
    let lock = fixture.home.join("MEMORY.md.lock");
    let owner = xal_services::storage::create_secure(&lock).unwrap();
    let operation = host.tool(
        "memory",
        json!({"operation":"clear","revision":current["revision"]})
            .as_object()
            .unwrap()
            .clone(),
        &session,
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        session.cancellation.cancel();
    };
    let (result, ()) = tokio::join!(operation, cancel);
    assert_eq!(result.unwrap_err(), Error::Cancelled);
    assert_eq!(
        fs::read_to_string(fixture.home.join("MEMORY.md")).unwrap(),
        "remembered"
    );
    assert!(lock.exists());
    drop(owner);
    fs::remove_file(lock).unwrap();
    redactor.protect(vec!["remembered".into()]).unwrap();
    assert!(host.session_prompts(&session).is_err());
    host.shutdown().await;
    assert!(host.failures().is_empty());
}
