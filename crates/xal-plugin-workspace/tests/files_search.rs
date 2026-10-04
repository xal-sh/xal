use std::fs;
use std::sync::Arc;

use serde_json::{Value, json};
use xal_host::*;
use xal_services::{redactor::Redactor, settings::Settings};

fn args(value: Value) -> JsonObject {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn files_search_web_gates_hashes_artifacts_and_cancellation_use_one_host() {
    let root = std::env::temp_dir().join(format!(
        "xal-workspace-tools-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    fs::create_dir_all(root.join(".git")).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(root.join("ignored.txt"), "needle").unwrap();
    fs::write(root.join("file.txt"), "needle\nsecond\n").unwrap();
    let mut host = Host::new(
        vec![
            Box::new(xal_plugin_workspace::Files),
            Box::new(xal_plugin_workspace::Search),
            Box::new(xal_plugin_workspace::Web),
            Box::new(xal_plugin_workspace::Shell),
        ],
        Cancellation::default(),
    );
    host.permissions(
        permissions::Permissions::load(
            &Settings::parse(&JsonObject::new()).unwrap(),
            &root,
            &root,
            "normal",
        )
        .unwrap(),
    );
    host.output_policy(
        Arc::new(Redactor::new(vec!["secret-fixture".into()]).unwrap()),
        root.join("artifacts"),
    );
    host.start().await.unwrap();
    let session = host
        .session("fixture".into(), root.clone(), SessionKind::Headless, false)
        .unwrap();
    for (name, input, title) in [
        ("read", json!({}), String::new()),
        ("read", json!({"file_path":"./file.txt"}), "file.txt".into()),
        (
            "write",
            json!({"file_path":root.join("file.txt")}),
            "file.txt".into(),
        ),
        ("edit", json!({"file_path":"."}), root.display().to_string()),
        (
            "grep",
            json!({"pattern":"needle","glob":"*.rs","path":"./src"}),
            "needle (*.rs) in src".into(),
        ),
        (
            "grep",
            json!({"pattern":false,"glob":"","path":""}),
            String::new(),
        ),
        (
            "glob",
            json!({"pattern":"**/*.rs","path":"."}),
            format!("**/*.rs in {}", root.display()),
        ),
        ("glob", json!({}), String::new()),
        (
            "webfetch",
            json!({"url":"https://example.test/page"}),
            "https://example.test/page".into(),
        ),
        ("webfetch", json!({"url":false}), String::new()),
        (
            "bash",
            json!({"command":"set -e\nprintf first\nprintf second"}),
            "set -e\nprintf first\nprintf second".into(),
        ),
        ("bash", json!({}), String::new()),
    ] {
        assert_eq!(
            host.tool_title(name, &args(input), &session).unwrap(),
            title,
            "{name}"
        );
    }
    let read = host
        .tool(
            "read",
            args(json!({"file_path":"file.txt","limit":1})),
            &session,
        )
        .await
        .unwrap()
        .output;
    assert!(read.contains("1: needle"));
    assert!(read.contains("offset=2"));
    fs::write(root.join("file.txt"), "external change\n").unwrap();
    assert!(
        host.tool(
            "write",
            args(json!({"file_path":"file.txt","content":"overwrite"})),
            &session
        )
        .await
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "external change\n"
    );
    host.tool("read", args(json!({"file_path":"file.txt"})), &session)
        .await
        .unwrap();
    host.tool("edit", args(json!({"file_path":"file.txt","old_string":"external change","new_string":"needle needle"})), &session).await.unwrap();
    assert!(
        host.tool(
            "edit",
            args(json!({"file_path":"file.txt","old_string":"needle","new_string":"replacement"})),
            &session
        )
        .await
        .is_err()
    );
    host.tool("edit", args(json!({"file_path":"file.txt","old_string":"needle","new_string":"found","replace_all":true})), &session).await.unwrap();
    let output = host
        .tool("grep", args(json!({"pattern":"found"})), &session)
        .await
        .unwrap()
        .output;
    assert!(output.contains("Found 1 matching lines"));
    let output = host
        .tool("glob", args(json!({"pattern":"*.txt"})), &session)
        .await
        .unwrap()
        .output;
    assert!(output.contains("file.txt"));
    assert!(!output.contains("ignored.txt"));
    assert!(
        host.tool("grep", args(json!({"pattern":"["})), &session)
            .await
            .is_err()
    );
    assert!(
        host.tool(
            "webfetch",
            args(json!({"url":"http://127.0.0.1"})),
            &session
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("internal address")
    );
    assert!(matches!(
        host.tool("read", args(json!({"file_path":".env"})), &session)
            .await,
        Err(Error::ApprovalRequired(_))
    ));
    let plan = host
        .session("plan".into(), root.clone(), SessionKind::Headless, true)
        .unwrap();
    assert!(
        !host
            .tools(&plan)
            .unwrap()
            .iter()
            .any(|tool| tool.name == "write" || tool.name == "edit")
    );
    assert!(matches!(
        host.tool("bash", args(json!({"command":"printf forbidden"})), &plan)
            .await,
        Err(Error::Denied(_))
    ));
    let schema = host
        .tools(&session)
        .unwrap()
        .into_iter()
        .find(|tool| tool.name == "bash")
        .unwrap();
    assert_eq!(
        schema.parameters["properties"].get("sandbox").is_some(),
        sandbox_available()
    );
    fs::write(root.join("shell-output.txt"), "secret-fixturesafe").unwrap();
    let output = host
        .tool(
            "bash",
            args(json!({"command":"cat shell-output.txt"})),
            &session,
        )
        .await
        .unwrap()
        .output;
    assert!(output.contains("[REDACTED]safe"));
    assert!(!output.contains("secret-fixture"));
    fs::write(
        root.join("shell-output.txt"),
        "secret-fixture\n".repeat(2100),
    )
    .unwrap();
    let output = host
        .tool(
            "bash",
            args(json!({"command":"cat shell-output.txt"})),
            &session,
        )
        .await
        .unwrap()
        .output;
    assert!(!output.contains("secret-fixture"));
    let artifacts = fs::read_dir(root.join("artifacts/fixture"))
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "txt"))
        .collect::<Vec<_>>();
    assert_eq!(artifacts.len(), 1);
    let saved = fs::read_to_string(artifacts[0].path()).unwrap();
    assert!(!saved.contains("secret-fixture"));
    assert_eq!(saved.matches("[REDACTED]").count(), 2100);
    assert_eq!(
        host.render(
            "bash",
            UiContribution::Text {
                text: "set -e\ncd /repo\nbun test".into()
            },
            &session
        )
        .await
        .unwrap(),
        "bun test"
    );
    assert_eq!(
        host.render(
            "grep",
            UiContribution::Tool {
                name: "grep".into(),
                output: "Found 3 matching lines".into()
            },
            &session
        )
        .await
        .unwrap(),
        "3 matches"
    );
    assert_eq!(
        host.render(
            "write",
            UiContribution::Tool {
                name: "write".into(),
                output: "Created file (2 lines)".into()
            },
            &session
        )
        .await
        .unwrap(),
        "+2 −0"
    );
    session.cancellation.cancel();
    assert_eq!(
        host.tool("read", args(json!({"file_path":"file.txt"})), &session)
            .await,
        Err(Error::Cancelled)
    );
    host.dispose_session(&session).await.unwrap();
    host.dispose_session(&plan).await.unwrap();
    host.shutdown().await;
    assert!(host.failures().is_empty());
    fs::remove_dir_all(root).unwrap();
}
