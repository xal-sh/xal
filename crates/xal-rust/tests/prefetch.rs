use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use serde_json::json;
use xal_host::*;
use xal_services::{credentials::new_id, redactor::Redactor, settings::Settings};

struct Hooks(Arc<AtomicUsize>);
impl Plugin for Hooks {
    fn name(&self) -> &str {
        "prefetch-fixture"
    }
    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let count = self.0.clone();
        registration.hook(
            "observe",
            Box::new(move |_, _| {
                let count = count.clone();
                Box::pin(async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(HookResult::Continue)
                })
            }),
        )
    }
}

#[tokio::test]
async fn speculative_reads_skip_hooks_artifacts_and_write_authorization() {
    let root = std::env::temp_dir().join(format!("xal-prefetch-{}", new_id().unwrap()));
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let path = root.join("fixture.txt");
    std::fs::write(&path, "fixture-secret\ncontent").unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let mut host = Host::new(
        vec![
            Box::new(xal_plugin_workspace::Files),
            Box::new(Hooks(count.clone())),
        ],
        Cancellation::default(),
    );
    host.output_policy(
        Arc::new(Redactor::new(vec!["fixture-secret".into()]).unwrap()),
        root.join("artifacts"),
    );
    host.permissions(
        permissions::Permissions::load(
            &Settings::parse(&JsonObject::new()).unwrap(),
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
    let output = host.prefetch_file(&path, &session).await.unwrap().unwrap();
    assert!(output.contains("[REDACTED]"));
    assert!(!output.contains("fixture-secret"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(
        host.prefetch_file(&root.join("missing.txt"), &session)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!root.join("artifacts").exists());
    let args = json!({"file_path":path,"content":"replacement"})
        .as_object()
        .unwrap()
        .clone();
    assert!(host.tool("write", args.clone(), &session).await.is_err());
    host.tool(
        "read",
        json!({"file_path":path}).as_object().unwrap().clone(),
        &session,
    )
    .await
    .unwrap();
    host.tool("write", args, &session).await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
    host.dispose_session(&session).await.unwrap();
    host.shutdown().await;
    std::fs::remove_dir_all(&root).unwrap();
}
