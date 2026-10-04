use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use xal_host::*;
use xal_services::{credentials::new_id, redactor::Redactor};

struct Fixture {
    failed: bool,
}
impl Plugin for Fixture {
    fn name(&self) -> &str {
        "fixture"
    }
    fn register(&mut self, r: &mut Registration) -> Result<()> {
        let failed = self.failed;
        r.provider(
            "fixture",
            Provider {
                settle: None,
                models: vec!["model".into()],
                stream: Box::new(move |_, _, sender| {
                    Box::pin(async move {
                        sender
                            .send(ProviderEvent::TextDelta("private prompt content".into()))
                            .await?;
                        let usage = ProviderEvent::Usage(Usage {
                            total_input_tokens: Some(21),
                            cache_read_input_tokens: Some(3),
                            cache_write_input_tokens: Some(4),
                            output_tokens: Some(5),
                        });
                        if failed {
                            return sender.try_send(usage);
                        }
                        sender.send(usage).await
                    })
                }),
            },
        )
    }
}
#[tokio::test]
async fn saturated_failed_and_interrupted_requests_record_usage_once_without_content() {
    for failed in [false, true] {
        let home = std::env::temp_dir().join(format!("xal-recording-{}", new_id().unwrap()));
        std::fs::create_dir(&home).unwrap();
        let redactor = Arc::new(Redactor::new(Vec::new()).unwrap());
        let recorder = recording::Recorder::new(&home, true, redactor.clone()).unwrap();
        let mut host = Host::new(vec![Box::new(Fixture { failed })], Cancellation::default());
        host.recorder = Some(recorder.clone());
        host.start().await.unwrap();
        let session = host
            .session(
                "private-session".into(),
                home.clone(),
                SessionKind::Headless,
                false,
            )
            .unwrap();
        let request = ProviderRequest {
            model: "model".into(),
            instructions: "private instructions".into(),
            input: vec![Item::user("private prompt content".into())],
            profile: None,
            tools: vec![],
            thinking: None,
            cache_key: "private-cache".into(),
            session_id: session.id.clone(),
            phase: recording::Phase::Turn,
            attempt: 1,
        };
        let (sender, _receiver) = channel(1, session.cancellation.clone()).unwrap();
        let (result, ()) =
            tokio::join!(host.provider("fixture", request, &session, sender), async {
                tokio::time::sleep(Duration::from_millis(25)).await;
                session.cancellation.cancel();
            });
        assert!(result.is_err());
        recorder.flush().unwrap();
        let usage = std::fs::read_to_string(
            std::fs::read_dir(home.join("usage"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap();
        let rows = usage
            .lines()
            .map(|s| serde_json::from_str::<Value>(s).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["outcome"],
            if failed { "failed" } else { "interrupted" }
        );
        assert_eq!(
            rows[0]["usage"],
            json!({"totalInputTokens":21,"cacheReadInputTokens":3,"cacheWriteInputTokens":4,"outputTokens":5})
        );
        assert_eq!(
            recording::read_usage(&home.join("usage")).unwrap()["requests"],
            1
        );
        let profile = std::fs::read_to_string(
            std::fs::read_dir(home.join("profiler"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap();
        assert!(!usage.contains("private"));
        assert!(!profile.contains("private"));
        assert!(!profile.contains("\"model\":\"model\""));
        host.shutdown().await;
        drop(host);
        drop(recorder);
        std::fs::remove_dir_all(&home).unwrap();
    }
}

#[test]
fn active_redaction_streams_observe_new_credentials_before_new_output() {
    let redactor = Redactor::new(vec!["old-token".into()]).unwrap();
    let mut stream = redactor.stream();
    assert_eq!(stream.write("old-"), "");
    redactor.protect(vec!["rotated-token".into()]).unwrap();
    let mut text = stream.write("token rotated-");
    text.push_str(&stream.write("token"));
    text.push_str(&stream.end());
    assert_eq!(text, "[REDACTED] [REDACTED]");
}

#[test]
fn calendar_usage_filters_sessions_and_providers_and_rejects_corrupt_tails() {
    let home = std::env::temp_dir().join(format!("xal-calendar-{}", new_id().unwrap()));
    std::fs::create_dir(&home).unwrap();
    let now = xal_services::time::parse("2024-03-12T12:00:00.000Z").unwrap();
    let record = |date: &str, provider: &str, version: u32| {
        json!({"version":version,"type":"provider_usage","id":"request","timestamp":date,"session":recording::fingerprint("session"),"provider":provider,"model":"model","phase":"turn","outcome":"completed","usage":{"totalInputTokens":3,"cacheReadInputTokens":1,"cacheWriteInputTokens":0,"outputTokens":2}}).to_string()
    };
    let path = home.join("usage.jsonl");
    let records = [
        record("2024-03-01T12:00:00.000Z", "mock", 1),
        record("2024-03-12T12:00:00.000Z", "mock", 2),
        record("2024-03-12T12:00:00.000Z", "other", 2),
    ]
    .join("\n");
    std::fs::write(&path, format!("{records}\n")).unwrap();
    let summary = recording::usage_summary(&home, Some("session"), &["mock".into()], now).unwrap();
    assert_eq!(summary["allTime"]["totalTokens"], 10);
    assert_eq!(summary["weekly"]["requests"], 1);
    assert_eq!(summary["session"]["requests"], 1);
    assert_eq!(summary["daily"].as_array().unwrap().len(), 2);
    std::fs::write(path, format!("{records}\n{{")).unwrap();
    assert!(recording::read_usage(&home).is_err());
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn usage_written_by_the_typescript_app_matches_its_totals() {
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/usage-summary.json")).unwrap();
    let summary = recording::usage_summary(
        std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/usage")),
        Some("ts-fixture-session"),
        &[],
        xal_services::time::parse("2024-03-12T12:00:00.000Z").unwrap(),
    )
    .unwrap();
    assert_eq!(summary["session"], expected["session"]);
    assert_eq!(summary["allTime"], expected["allTime"]);
}
