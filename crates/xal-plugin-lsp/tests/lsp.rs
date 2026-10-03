#[path = "../../xal-services/tests/lsp/support.rs"]
mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use support::Fixture;
use xal_host::*;
use xal_plugin_lsp::Lsp;
use xal_services::redactor::Redactor;
use xal_services::settings::Settings;

fn config(fixture: &Fixture, mode: &str) -> JsonObject {
    let mut server = serde_json::to_value(fixture.config(mode)).unwrap();
    let fields = server.as_object_mut().unwrap();
    fields.remove("id");
    fields.remove("install");
    json!({"servers":{"typescript":{"enabled":false},"python":{"enabled":false},"rust":{"enabled":false},"go":{"enabled":false},"fixture":server}}).as_object().unwrap().clone()
}

async fn host(fixture: &Fixture, config: JsonObject, redactor: Arc<Redactor>, deny: bool) -> Host {
    let plugin = Lsp::new(&config, fixture.root.clone(), redactor.clone()).unwrap();
    let mut host = Host::new(vec![Box::new(plugin)], Cancellation::default());
    let mut settings = Settings::parse(&JsonObject::new()).unwrap();
    if deny {
        settings.permissions.deny.push("lsp(source.fake)".into());
    }
    host.permissions(
        permissions::Permissions::load(
            &settings,
            &fixture.root.join("home"),
            &fixture.root,
            "plan",
        )
        .unwrap(),
    );
    host.output_policy(redactor, fixture.root.join("outputs"));
    host.start().await.unwrap();
    host
}

fn args() -> JsonObject {
    json!({"operation":"hover","file_path":"source.fake","line":2,"column":4})
        .as_object()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn plugin_registers_secrets_read_policy_renderer_status_and_restart() {
    let fixture = Fixture::new();
    let redactor = Arc::new(Redactor::new(Vec::new()).unwrap());
    let mut configuration = config(&fixture, "full");
    configuration["servers"]["fixture"]["env"] = json!({"FIXTURE_TOKEN":"synthetic-secret"});
    std::fs::write(fixture.root.join("source.fake"), "synthetic-secret").unwrap();
    let mut host = host(&fixture, configuration, redactor.clone(), false).await;
    assert_eq!(redactor.redact("synthetic-secret"), "[REDACTED]");
    assert!(
        host.execute("lsp", &[])
            .await
            .unwrap()
            .contains("fixture · idle")
    );
    assert!(host.execute("lsp", &["invalid".into()]).await.is_err());
    for kind in [
        SessionKind::Headless,
        SessionKind::Interactive,
        SessionKind::Task,
    ] {
        let session = host
            .session(format!("{kind:?}"), fixture.root.clone(), kind, true)
            .unwrap();
        let tools = host.tools(&session).unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "lsp");
        assert_eq!(
            host.tool_title("lsp", &args(), &session).unwrap(),
            "hover · source.fake"
        );
        assert_eq!(
            host.tool_title("lsp", &JsonObject::new(), &session)
                .unwrap(),
            "query · "
        );
        let prepared = host.prepare_tool("lsp", args(), &session).await.unwrap();
        let result = host.execute_tool(prepared, &session).await.unwrap();
        assert_eq!(result.output, "Hover information\n[REDACTED]");
        assert_eq!(
            host.render(
                "lsp",
                UiContribution::Tool {
                    name: "lsp".into(),
                    output: result.output
                },
                &session
            )
            .await
            .unwrap(),
            "hover"
        );
    }
    assert!(
        host.execute("lsp", &[])
            .await
            .unwrap()
            .contains("fixture · ready")
    );
    assert!(
        host.execute("lsp", &["restart".into(), "fixture".into()])
            .await
            .unwrap()
            .contains("fixture · idle")
    );
    fixture.assert_stopped("full");
    host.shutdown().await;
    assert!(host.failures().is_empty());
}

#[tokio::test]
async fn permission_denial_and_unavailable_catalog_do_not_start_processes() {
    let fixture = Fixture::new();
    let redactor = Arc::new(Redactor::new(Vec::new()).unwrap());
    let mut host = host(&fixture, config(&fixture, "full"), redactor.clone(), true).await;
    let session = host
        .session(
            "denied".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            true,
        )
        .unwrap();
    let prepared = host.prepare_tool("lsp", args(), &session).await.unwrap();
    assert!(host.execute_tool(prepared, &session).await.is_err());
    assert!(fixture.messages("full").is_empty());
    host.shutdown().await;
    let mut config = config(&fixture, "full");
    config["servers"]["fixture"]["command"] = json!(fixture.root.join("missing-executable"));
    let mut unavailable = self::host(&fixture, config, redactor, false).await;
    let session = unavailable
        .session(
            "unavailable".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            true,
        )
        .unwrap();
    assert!(unavailable.tools(&session).unwrap().is_empty());
    assert!(
        unavailable
            .prepare_tool("lsp", args(), &session)
            .await
            .is_err()
    );
    assert!(
        unavailable
            .execute("lsp", &[])
            .await
            .unwrap()
            .contains("unavailable")
    );
    unavailable.shutdown().await;
}

#[tokio::test]
async fn host_cancellation_settles_native_work_and_shutdown_cleans_processes() {
    let fixture = Fixture::new();
    let redactor = Arc::new(Redactor::new(Vec::new()).unwrap());
    let mut host = host(&fixture, config(&fixture, "hang-query"), redactor, false).await;
    let session = host
        .session(
            "cancelled".into(),
            fixture.root.clone(),
            SessionKind::Headless,
            true,
        )
        .unwrap();
    let prepared = host.prepare_tool("lsp", args(), &session).await.unwrap();
    let cancel = async {
        while !fixture
            .messages("hang-query")
            .iter()
            .any(|message| message["method"] == "textDocument/hover")
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        session.cancellation.cancel();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(host.execute_tool(prepared, &session), cancel)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), Error::Cancelled);
    host.shutdown().await;
    assert!(host.failures().is_empty());
    fixture.assert_stopped("hang-query");
    let manager = fixture.manager("full");
    manager
        .query(
            &fixture.query(xal_services::lsp::Operation::Diagnostics),
            &fixture.root,
            &|| false,
        )
        .unwrap();
    fixture.wait_for("full", |message| {
        message["method"] == "textDocument/didOpen"
    });
    manager.close().unwrap();
    fixture.assert_stopped("full");
}
