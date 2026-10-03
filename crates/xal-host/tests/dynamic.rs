use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use serde_json::json;
use xal_host::*;
use xal_services::settings::Settings;

struct Dynamic {
    catalog: Arc<Mutex<BTreeMap<String, Arc<Tool>>>>,
    disposed: Arc<AtomicUsize>,
}

fn tool(subject: &'static str, effects: fn(&JsonObject) -> Effects) -> Arc<Tool> {
    Arc::new(Tool {
        title: Some(Box::new(move |_, session| Ok(format!("{subject} in {}", session.cwd.display())))),
        description: "dynamic fixture".into(),
        parameters: json!({"type":"object","properties":{"path":{"type":"string"},"blocked":{"type":"boolean"},"stream":{"type":"boolean"}}}).as_object().unwrap().clone(),
        effects,
        concurrency: None,
        permission_subject: Some(Box::new(move |args| Ok(if args.get("blocked").and_then(serde_json::Value::as_bool) == Some(true) { "server/blocked" } else { subject }.into()))),
        redact: None,
        available: Box::new(|_| Ok(true)),
        run: Box::new(|args, context| Box::pin(async move {
            if let Some(path) = args.get("path").and_then(serde_json::Value::as_str) { context.change_workspace(path.into())?; }
            if args.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                context.output.as_ref().unwrap().send("progress".into()).await?;
                context.cancellation.cancelled().await;
                return Err(Error::Cancelled);
            }
            Ok(ToolResult { output: context.session.cwd.display().to_string() })
        })),
    })
}

impl Plugin for Dynamic {
    fn name(&self) -> &str {
        "dynamic"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let catalog = self.catalog.clone();
        registration.dynamic_tools(
            "remote__",
            Box::new(move |_| Ok(catalog.lock().unwrap().clone())),
        )?;
        registration.prompt_source(
            "workspace",
            Box::new(|session| Ok(session.cwd.display().to_string())),
        )?;
        registration.command("owned", "fixture", |_, _| Ok("fixture".into()))?;
        registration.command_async("settle", "fixture", |_, cancellation| {
            Box::pin(async move {
                cancellation.cancel();
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Err(Error::Failed("settled cleanup fixture".into()))
            })
        })?;
        registration.hook(
            "rewrite",
            Box::new(|input, context| {
                Box::pin(async move {
                    assert_eq!(context.command_owner("owned"), Some("dynamic"));
                    let HookInput::BeforeTool { mut args, .. } = input else {
                        return Ok(HookResult::Continue);
                    };
                    if args.contains_key("blocked") {
                        args.insert("blocked".into(), true.into());
                    }
                    Ok(HookResult::ReplaceArguments(args))
                })
            }),
        )?;
        let disposed = self.disposed.clone();
        registration.session_disposer(Box::new(move |_, _| {
            disposed.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }));
        Ok(())
    }
}

#[tokio::test]
async fn changing_catalogs_revalidate_permissions_and_workspace_invalidation() {
    let root = std::env::temp_dir().join(format!(
        "xal-host-dynamic-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    std::fs::create_dir_all(root.join("next")).unwrap();
    let root = root.canonicalize().unwrap();
    let catalog = Arc::new(Mutex::new(BTreeMap::new()));
    let disposed = Arc::new(AtomicUsize::new(0));
    let mut host = Host::new(
        vec![Box::new(Dynamic {
            catalog: catalog.clone(),
            disposed: disposed.clone(),
        })],
        Cancellation::default(),
    );
    host.permissions(
        permissions::Permissions::load(
            &Settings::parse(
                json!({"permissions":{"deny":["remote__*(server/blocked)"]}})
                    .as_object()
                    .unwrap(),
            )
            .unwrap(),
            &root,
            &root,
            "yolo",
        )
        .unwrap(),
    );
    host.start().await.unwrap();
    let session = host
        .session("fixture".into(), root.clone(), SessionKind::Headless, false)
        .unwrap();
    assert!(host.tools(&session).unwrap().is_empty());
    catalog
        .lock()
        .unwrap()
        .insert("remote__call".into(), tool("server/first", Effects::read));
    assert_eq!(host.tools(&session).unwrap()[0].name, "remote__call");
    assert_eq!(
        host.tool_title("remote__call", &JsonObject::new(), &session)
            .unwrap(),
        format!("server/first in {}", root.display())
    );
    assert!(matches!(
        host.tool(
            "remote__call",
            json!({"blocked":false}).as_object().unwrap().clone(),
            &session
        )
        .await,
        Err(Error::Denied(_))
    ));
    let prepared = host
        .prepare_tool("remote__call", JsonObject::new(), &session)
        .await
        .unwrap();
    catalog
        .lock()
        .unwrap()
        .insert("remote__call".into(), tool("server/changed", Effects::read));
    assert!(
        host.execute_tool(prepared, &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("subject changed")
    );
    let mut shared = tool("server/changed", Effects::write);
    Arc::get_mut(&mut shared).unwrap().concurrency = Some(|_| Concurrency::Shared);
    catalog
        .lock()
        .unwrap()
        .insert("remote__call".into(), shared);
    let prepared = host
        .prepare_tool("remote__call", JsonObject::new(), &session)
        .await
        .unwrap();
    assert!(matches!(
        host.tool(
            "remote__call",
            json!({"path":root.join("next")})
                .as_object()
                .unwrap()
                .clone(),
            &session,
        )
        .await,
        Err(Error::Denied(_))
    ));
    catalog.lock().unwrap().insert(
        "remote__call".into(),
        tool("server/changed", Effects::write),
    );
    assert!(
        host.execute_tool(prepared, &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("effects changed")
    );
    let prepared = host
        .prepare_tool("remote__call", JsonObject::new(), &session)
        .await
        .unwrap();
    catalog.lock().unwrap().clear();
    assert!(
        host.execute_tool(prepared, &session)
            .await
            .unwrap_err()
            .to_string()
            .contains("removed")
    );
    catalog.lock().unwrap().insert(
        "remote__switch".into(),
        tool("server/switch", Effects::write),
    );
    let stale = host
        .prepare_tool("remote__switch", JsonObject::new(), &session)
        .await
        .unwrap();
    host.tool(
        "remote__switch",
        json!({"path":root.join("next")})
            .as_object()
            .unwrap()
            .clone(),
        &session,
    )
    .await
    .unwrap();
    assert_eq!(
        host.effective_session(&session).unwrap().cwd,
        root.join("next")
    );
    assert_eq!(
        host.session_prompts(&session).unwrap(),
        [root.join("next").display().to_string()]
    );
    assert_eq!(disposed.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.tool_title("remote__switch", &JsonObject::new(), &session)
            .unwrap(),
        format!("server/switch in {}", root.join("next").display())
    );
    assert!(matches!(
        host.execute_tool(stale, &session).await,
        Err(Error::Denied(_))
    ));
    let task = host
        .session("task".into(), root.clone(), SessionKind::Task, false)
        .unwrap();
    assert!(matches!(
        host.tool(
            "remote__switch",
            json!({"path":root.join("next")})
                .as_object()
                .unwrap()
                .clone(),
            &task
        )
        .await,
        Err(Error::Denied(_))
    ));
    let streaming = host
        .session(
            "streaming".into(),
            root.clone(),
            SessionKind::Headless,
            false,
        )
        .unwrap();
    let (sender, receiver) = channel(1, Cancellation::default()).unwrap();
    drop(receiver);
    let prepared = host
        .prepare_tool(
            "remote__switch",
            json!({"path":root.join("next"),"stream":true})
                .as_object()
                .unwrap()
                .clone(),
            &streaming,
        )
        .await
        .unwrap();
    assert!(
        host.execute_tool_streaming(prepared, &streaming, Some(sender))
            .await
            .is_err()
    );
    assert_eq!(
        host.effective_session(&streaming).unwrap().cwd,
        root.join("next")
    );
    assert!(streaming.cancellation.check().is_err());
    assert_eq!(
        host.execute("settle", &[]).await,
        Err(Error::Failed("settled cleanup fixture".into()))
    );
    assert_eq!(host.execute("owned", &[]).await.unwrap(), "fixture");
    host.dispose_session(&streaming).await.unwrap();
    host.dispose_session(&session).await.unwrap();
    host.dispose_session(&task).await.unwrap();
    host.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}
