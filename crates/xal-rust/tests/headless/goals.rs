use super::*;

#[test]
fn goal_loop_uses_an_offered_alias_without_tools_and_preserves_json_output() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        json!({"evaluatorModels":{"openai":"gpt-4.1-1m"}}).to_string(),
    )
    .unwrap();
    let server = Server::new(vec![
        answer("first evidence"),
        answer(r#"{"verdict":"not_yet_met","reason":"need another check"}"#),
        answer("verified evidence"),
        answer(r#"{"verdict":"met","reason":"all checks passed"}"#),
    ]);
    let output = fixture.run(
        &server,
        &["--format", "json", "/goal verify the evidence"],
        "",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["goal"]["status"], "achieved");
    assert_eq!(result["goal"]["evaluatedTurns"], 2);
    let requests = server.requests();
    assert_eq!(requests.len(), 4);
    for index in [1, 3] {
        assert!(
            requests[index]["tools"]
                .as_array()
                .is_none_or(|tools| tools.is_empty())
        );
        assert_eq!(requests[index]["model"], "gpt-4.1");
    }
    let loaded = xal_services::sessions::load(&fixture.journals()[0]).unwrap();
    assert_eq!(
        loaded
            .events
            .iter()
            .filter(|e| e["type"] == "turn_ended")
            .count(),
        2
    );
    assert!(
        !loaded
            .conversation
            .items
            .iter()
            .any(|item| item.to_string().contains("\\\"verdict\\\""))
    );
}

#[test]
fn unrelated_evaluator_configuration_does_not_block_ordinary_prompts() {
    let fixture = Fixture::new();
    fs::write(
        fixture.home.join("config.json"),
        json!({"evaluatorModels":{"openai":"not-offered"}}).to_string(),
    )
    .unwrap();
    let server = Server::new(vec![answer("ordinary response")]);
    let output = fixture.run(&server, &["ordinary prompt"], "");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests().len(), 1);
}
