use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use xal_host::*;
use xal_plugin_mcp::{Confirmation, Mcp, config, project};
use xal_services::{config::Configuration, redactor::Redactor, settings::Settings};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-mcp-plugin-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        let home = root.join("home");
        let project = root.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        Self {
            root,
            home,
            project,
        }
    }
    fn write(&self, path: &str, value: Value) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn load(&self) -> Configuration {
        Configuration::load(&self.home, &self.project).unwrap()
    }
    fn trust(&self) {
        xal_services::config::set_trust(&self.home, &self.project, true).unwrap();
    }
    fn executable(&self) -> PathBuf {
        let executable = self.root.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        let output = std::process::Command::new("rustc")
            .args(["--edition=2024", "-o"])
            .arg(&executable)
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../xal-services/tests/mcp_fixture/server.rs"),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        executable
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn object(value: Value) -> JsonObject {
    value.as_object().unwrap().clone()
}

#[test]
fn configuration_expands_only_active_fields_and_registers_secrets() {
    let values = object(json!({"servers":{
        "stdio":{"transport":"stdio","command":"${BIN}","args":["${TOKEN}","${not-valid}"],"cwd":"sub/../work","env":{"API_KEY":"prefix-${TOKEN}","PLAIN":"hello"},"url":false},
        "http":{"transport":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"},"command":false}
    }}));
    let parsed =
        config::parse_with_environment(&values, std::path::Path::new("/project"), &|name| {
            Ok(match name {
                "BIN" => Some("fixture".into()),
                "TOKEN" => Some("SECRET".into()),
                _ => None,
            })
        })
        .unwrap();
    assert_eq!(parsed.servers.len(), 2);
    assert!(parsed.secrets.contains(&"SECRET".into()));
    assert!(parsed.secrets.contains(&"prefix-SECRET".into()));
    assert!(parsed.secrets.contains(&"Bearer SECRET".into()));
    let stdio = parsed
        .servers
        .iter()
        .find(|server| server.id() == "stdio")
        .unwrap();
    let xal_services::mcp::ServerConfig::Stdio {
        command, args, cwd, ..
    } = stdio
    else {
        panic!();
    };
    assert_eq!(command, "fixture");
    assert_eq!(args, &["SECRET", "${not-valid}"]);
    assert_eq!(cwd.as_ref().unwrap(), &PathBuf::from("/project/work"));
    assert!(
        config::parse_with_environment(&values, std::path::Path::new("/project"), &|_| Ok(None))
            .err()
            .unwrap()
            .to_string()
            .contains("missing environment variable")
    );
    for value in [
        json!({"unexpected":true}),
        json!({"servers":{"Bad":{"transport":"stdio","command":"x"}}}),
        json!({"servers":{"bad":{"transport":"stdio","command":"x","timeoutMs":0}}}),
        json!({"servers":{"bad":{"transport":"http","url":"file:///tmp/x"}}}),
        json!({"servers":{"bad":{"transport":"stdio","command":"x","extra":true}}}),
    ] {
        assert!(config::parse(&object(value), std::path::Path::new("/project")).is_err());
    }
}

#[test]
fn project_discovery_requires_trust_and_consent_and_preserves_raw_sources() {
    let fixture = Fixture::new();
    fixture.write("home/config.json", json!({"pluginConfig":{"mcp":{"servers":{"existing":{"transport":"stdio","command":"global"}}}}}));
    fixture.write("project/.mcp.json", json!({"mcpServers":{"existing":{"command":"ignored"},"new":{"type":"streamable-http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${MCP_TOKEN}"}}}}));
    assert!(
        project::discover(&fixture.load(), true)
            .unwrap()
            .additions
            .is_empty()
    );
    fixture.trust();
    let discovery = project::discover(&fixture.load(), false).unwrap();
    assert_eq!(discovery.conflicts, ["existing"]);
    assert_eq!(discovery.additions.len(), 1);
    assert!(discovery.notices.join(" ").contains("Ignoring unapproved"));
    assert!(
        project::approve(
            fixture.load(),
            &fixture.home,
            &fixture.project,
            false,
            project::Choice::Session
        )
        .is_err()
    );
    let session = project::approve(
        fixture.load(),
        &fixture.home,
        &fixture.project,
        true,
        project::Choice::Session,
    )
    .unwrap();
    assert_eq!(
        project::sources(&session, &fixture.home).unwrap()["new"],
        project::Source::Session
    );
    assert!(!fixture.project.join(".xal/config.json").exists());
    fixture.write("project/.xal/config.json", json!({"pluginConfig":{"other":{"unchanged":true},"mcp":{"servers":{"existing":{"transport":"stdio","command":"project"}}}}}));
    let imported = project::approve(
        fixture.load(),
        &fixture.home,
        &fixture.project,
        true,
        project::Choice::Project,
    )
    .unwrap();
    assert_eq!(
        project::sources(&imported, &fixture.home).unwrap()["existing"],
        project::Source::Project
    );
    let stored: Value =
        serde_json::from_slice(&fs::read(fixture.project.join(".xal/config.json")).unwrap())
            .unwrap();
    assert_eq!(stored["pluginConfig"]["other"]["unchanged"], true);
    assert_eq!(
        stored["pluginConfig"]["mcp"]["servers"]["new"]["headers"]["Authorization"],
        "Bearer ${MCP_TOKEN}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(fixture.project.join(".xal/config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    project::delete(
        &fixture.home,
        &fixture.project,
        "existing",
        project::Source::Project,
    )
    .unwrap();
    assert_eq!(
        fixture.load().values["pluginConfig"]["mcp"]["servers"]["existing"]["command"],
        "global"
    );
    assert!(
        project::delete(
            &fixture.home,
            &fixture.project,
            "existing",
            project::Source::Project
        )
        .is_err()
    );
    for value in [
        json!({"mcpServers":{"bad":{"command":"x","url":"https://example.test"}}}),
        json!({"mcpServers":{"bad":{"type":"sse","url":"https://example.test"}}}),
        json!({"mcpServers":{"bad":{"command":"x","transport":"stdio"}}}),
    ] {
        assert!(project::parse(&value).is_err());
    }
    fs::write(fixture.project.join(".mcp.json"), "invalid").unwrap();
    assert!(project::discover(&fixture.load(), true).is_err());
}

#[tokio::test]
async fn plugin_deferred_tools_policies_session_isolation_and_confirmed_delete() {
    let fixture = Fixture::new();
    let executable = fixture.executable();
    fixture.write("home/config.json", json!({"pluginConfig":{"mcp":{"servers":{"good":{"transport":"stdio","command":executable,"timeoutMs":2000,"env":{"MCP_TOKEN":"SUPERSECRET"}},"broken":{"transport":"stdio","command":fixture.root.join("missing")}}}}}));
    let redactor = Arc::new(Redactor::new(Vec::new()).unwrap());
    let plugin = Mcp::new(
        &fixture.load(),
        fixture.home.clone(),
        fixture.project.clone(),
        redactor.clone(),
    )
    .unwrap();
    let controller = plugin.controller();
    assert_ne!(redactor.redact("SUPERSECRET"), "SUPERSECRET");
    let mut host = Host::new(vec![Box::new(plugin)], Cancellation::default());
    host.output_policy(redactor, fixture.home.join("artifacts"));
    host.start().await.unwrap();
    assert!(controller.status(None).unwrap().contains("broken · failed"));
    assert!(
        host.warnings()
            .iter()
            .any(|warning| warning.contains("broken · failed"))
    );
    let session = host
        .session(
            "primary".into(),
            fixture.project.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    let other = host
        .session(
            "other".into(),
            fixture.project.clone(),
            SessionKind::Task,
            false,
        )
        .unwrap();
    assert!(
        host.tools(&session)
            .unwrap()
            .iter()
            .all(|tool| !tool.name.starts_with("mcp__"))
    );
    assert!(
        host.session_prompts(&session)
            .unwrap()
            .iter()
            .all(String::is_empty)
    );
    host.tool("mcp_tool_search", object(json!({"query":"echo"})), &session)
        .await
        .unwrap();
    let echo = host
        .tools(&session)
        .unwrap()
        .into_iter()
        .find(|tool| tool.name.starts_with("mcp__good__echo_tool_"))
        .unwrap();
    assert_eq!(echo.parameters["required"], json!(["value"]));
    assert_eq!(
        host.tool_title(&echo.name, &JsonObject::new(), &session)
            .unwrap(),
        "good: echo tool"
    );
    for (name, input, title) in [
        ("mcp_tool_search", json!({}), "MCP tools"),
        ("mcp_tool_search", json!({"query":"echo"}), "echo"),
        ("mcp_resources", json!({}), "all MCP servers"),
        ("mcp_prompts", json!({"server":"good"}), "good"),
        ("mcp_read_resource", json!({}), "MCP: resource"),
        (
            "mcp_read_resource",
            json!({"server":"good","uri":"fixture://one"}),
            "good: fixture://one",
        ),
        ("mcp_get_prompt", json!({}), "MCP: prompt"),
        (
            "mcp_get_prompt",
            json!({"server":"good","name":"review"}),
            "good: review",
        ),
    ] {
        assert_eq!(
            host.tool_title(name, &object(input), &session).unwrap(),
            title
        );
    }
    assert_eq!(
        host.tool_title(&echo.name, &JsonObject::new(), &other)
            .unwrap(),
        echo.name
    );
    assert!(
        host.session_prompts(&session)
            .unwrap()
            .join(" ")
            .contains("Use fixture tools.")
    );
    assert!(
        host.tools(&other)
            .unwrap()
            .iter()
            .all(|tool| !tool.name.starts_with("mcp__"))
    );
    let read_only = Session {
        read_only: true,
        ..session.clone()
    };
    assert!(matches!(
        host.tool(&echo.name, object(json!({"value":"hello"})), &read_only)
            .await,
        Err(Error::Denied(_))
    ));
    assert!(
        host.tool("mcp_resources", object(json!({})), &read_only)
            .await
            .unwrap()
            .output
            .contains("fixture://two")
    );
    assert!(matches!(
        host.tool(
            "mcp_read_resource",
            object(json!({"server":"good","uri":"fixture://one"})),
            &read_only
        )
        .await,
        Err(Error::Denied(_))
    ));
    for (rule, denied) in [("ask", false), ("deny", true)] {
        let settings = Settings::parse(&object(
            json!({"permissions":{rule:[format!("{}(good/echo tool)", echo.name)]}}),
        ))
        .unwrap();
        host.permissions(
            permissions::Permissions::load(&settings, &fixture.home, &fixture.project, "normal")
                .unwrap(),
        );
        let error = host
            .tool(&echo.name, object(json!({"value":"hello"})), &session)
            .await
            .unwrap_err();
        assert!(
            if denied {
                matches!(error, Error::Denied(_))
            } else {
                matches!(error, Error::ApprovalRequired(_))
            },
            "{error:?}"
        );
    }
    host.permissions(
        permissions::Permissions::load(
            &Settings::parse(&object(json!({}))).unwrap(),
            &fixture.home,
            &fixture.project,
            "normal",
        )
        .unwrap(),
    );
    assert!(
        host.tool(&echo.name, object(json!({"value":2})), &session)
            .await
            .is_err()
    );
    let result = host
        .tool(&echo.name, object(json!({"value":"hello"})), &session)
        .await
        .unwrap();
    assert!(result.output.contains("hello"));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if host
                .tools(&session)
                .unwrap()
                .iter()
                .all(|tool| tool.name != echo.name)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        host.session_prompts(&session)
            .unwrap()
            .iter()
            .all(String::is_empty)
    );
    controller
        .reconnect(Some("good"), &Cancellation::default())
        .await
        .unwrap();
    host.tool("mcp_tool_search", object(json!({"query":"slow"})), &session)
        .await
        .unwrap();
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        session.cancellation.cancel();
    };
    let pending = host.tool("mcp__good__slow", object(json!({})), &session);
    let (result, ()) = tokio::join!(pending, cancel);
    assert_eq!(result.unwrap_err(), Error::Cancelled);
    host.dispose_session(&session).await.unwrap();
    assert!(matches!(
        controller
            .command(&["delete".into(), "good".into()], &Cancellation::default())
            .await,
        Err(Error::ApprovalRequired(_))
    ));
    assert_eq!(
        controller
            .delete("good", Confirmation::Cancel, &Cancellation::default())
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        controller
            .delete("good", Confirmation::Confirm, &Cancellation::default())
            .await
            .unwrap(),
        Some(project::Source::Global)
    );
    assert!(
        fixture.load().values["pluginConfig"]["mcp"]["servers"]
            .get("good")
            .is_none()
    );
    assert!(
        controller
            .status(Some("good"))
            .unwrap()
            .contains("No MCP servers")
    );
    host.shutdown().await;
    assert!(host.failures().is_empty(), "{:?}", host.failures());
}
