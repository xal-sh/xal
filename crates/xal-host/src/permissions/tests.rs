use super::*;
use serde_json::json;

#[test]
fn remembered_approvals_remain_workspace_scoped_across_modes_and_reload() {
    let home = std::env::temp_dir().join(format!(
        "xal-grants-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    std::fs::create_dir(&home).unwrap();
    let one = home.join("one");
    let two = home.join("two");
    let settings = Settings::parse(
        json!({"permissions":{"deny":["bash(sudo forbidden)"]}})
            .as_object()
            .unwrap(),
    )
    .unwrap();
    let request = PermissionRequest {
        tool: "bash".into(),
        args: json!({"command":"sudo example"})
            .as_object()
            .unwrap()
            .clone(),
        read_only: false,
        subject: None,
    };
    let mut policy = Permissions::load(&settings, &home, &one, "normal").unwrap();
    assert!(matches!(
        policy.evaluate(&request, &one).unwrap(),
        PolicyDecision::Ask(_)
    ));
    policy
        .remember(&request, &one, "bash(sudo *)", true)
        .unwrap();
    assert!(policy.granted(&request, &one).unwrap());
    assert!(!policy.granted(&request, &two).unwrap());
    let host = crate::Host::new(Vec::new(), crate::Cancellation::default());
    host.session_permissions("session", policy).unwrap();
    for mode in ["plan", "normal"] {
        host.session_permissions(
            "session",
            Permissions::load(&settings, &home, &two, mode).unwrap(),
        )
        .unwrap();
        let policy = host.permission_for("session").unwrap().unwrap();
        assert!(policy.granted(&request, &one).unwrap());
        assert!(!policy.granted(&request, &two).unwrap());
        let denied = PermissionRequest {
            args: json!({"command":"sudo forbidden"})
                .as_object()
                .unwrap()
                .clone(),
            ..request.clone()
        };
        assert!(matches!(
            policy.evaluate(&denied, &one).unwrap(),
            PolicyDecision::Deny(_)
        ));
        if mode == "plan" {
            assert!(matches!(
                policy.evaluate(&request, &one).unwrap(),
                PolicyDecision::Deny(_)
            ));
        }
    }
    let mut reloaded = Permissions::load(&settings, &home, &two, "normal").unwrap();
    assert!(reloaded.granted(&request, &one).unwrap());
    assert!(!reloaded.granted(&request, &two).unwrap());
    reloaded
        .remember(&request, &two, "bash(sudo *)", false)
        .unwrap();
    assert!(reloaded.granted(&request, &two).unwrap());
    assert!(
        !Permissions::load(&settings, &home, &two, "normal")
            .unwrap()
            .granted(&request, &two)
            .unwrap()
    );
    std::fs::remove_dir_all(home).unwrap();
}
