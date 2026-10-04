use super::*;

fn jobs() -> Jobs {
    Jobs::new(
        None,
        Arc::new(Redactor::new(vec!["fixture-secret".into()]).unwrap()),
    )
}

#[tokio::test]
async fn explicit_collection_and_cancelled_waits_have_exactly_one_delivery_owner() {
    let jobs = jobs();
    let job = jobs
        .create(
            Kind::Agent {
                task: "work".into(),
            },
            true,
        )
        .unwrap();
    let cancelled = Cancellation::default();
    cancelled.cancel();
    assert_eq!(
        jobs.collect(&job.id, Duration::from_secs(30), &cancelled)
            .await,
        Err(Error::Cancelled)
    );
    job.append("report").unwrap();
    job.finish(Status::Completed, "completed".into()).unwrap();
    assert!(
        jobs.collect(&job.id, Duration::ZERO, &Cancellation::default())
            .await
            .unwrap()
            .contains("report")
    );
    assert!(jobs.deliveries().unwrap().is_empty());
    assert!(
        jobs.collect(&job.id, Duration::ZERO, &Cancellation::default())
            .await
            .unwrap()
            .contains("already collected")
    );
    let job = jobs
        .create(
            Kind::Agent {
                task: "next".into(),
            },
            true,
        )
        .unwrap();
    job.append("next report").unwrap();
    job.finish(Status::Completed, "completed".into()).unwrap();
    let deliveries = jobs.deliveries().unwrap();
    assert_eq!(deliveries.len(), 1);
    assert!(jobs.deliveries().unwrap().is_empty());
    for (job, _) in deliveries {
        jobs.delivered(&job, true).unwrap();
    }
    assert!(jobs.deliveries().unwrap().is_empty());
    jobs.shutdown().await.unwrap();
}

#[tokio::test]
async fn schedules_wake_on_activity_and_cancellation_without_automatic_delivery() {
    let jobs = jobs();
    let cancellation = Cancellation::default();
    let wait = jobs.schedule(30_000, &cancellation);
    let wake = async {
        tokio::task::yield_now().await;
        jobs.activity.notify_waiters();
    };
    let (result, ()) = tokio::join!(wait, wake);
    assert!(result.unwrap().contains("activity"));
    cancellation.cancel();
    assert!(
        jobs.schedule(30_000, &cancellation)
            .await
            .unwrap()
            .contains("interrupted")
    );
    assert!(jobs.deliveries().unwrap().is_empty());
    jobs.shutdown().await.unwrap();
}

#[test]
fn output_bounds_use_utf16_and_streaming_recovers_invalid_utf8_without_losing_split_suffixes() {
    let jobs = jobs();
    let job = jobs
        .create(
            Kind::Process {
                command: "fixture".into(),
            },
            true,
        )
        .unwrap();
    let text = format!("{}{}", "😀".repeat(250_000), "tail");
    job.append(&text).unwrap();
    let output = job.output().unwrap();
    assert!(output.starts_with('😀'));
    assert!(output.contains("output omitted"));
    assert!(output.ends_with("tail"));
    assert!(output.encode_utf16().count() < 401_000);
    assert!(job.take_output().unwrap().encode_utf16().count() < 257_000);
    let job = jobs
        .create(
            Kind::Process {
                command: "fixture".into(),
            },
            true,
        )
        .unwrap();
    let redactor = Redactor::new(vec!["fixture-secret".into()]).unwrap();
    let mut stream = redactor.stream();
    let mut bytes = vec![0xff, 0xf0, 0x9f];
    let mut saved = 0;
    append_process(&job, &mut None, &mut bytes, &mut stream, &mut saved, false).unwrap();
    bytes.extend([0x98, 0x80]);
    bytes.extend(b"fixture-se");
    append_process(&job, &mut None, &mut bytes, &mut stream, &mut saved, false).unwrap();
    bytes.extend(b"cret");
    append_process(&job, &mut None, &mut bytes, &mut stream, &mut saved, true).unwrap();
    let output = job.output().unwrap();
    assert!(output.starts_with("�😀"), "{output}");
    assert!(!output.contains("fixture-secret"));
}

#[test]
fn stopping_processes_cannot_be_promoted_before_settlement() {
    let jobs = jobs();
    let job = jobs
        .create(
            Kind::Process {
                command: "fixture".into(),
            },
            false,
        )
        .unwrap();
    {
        let mut state = job.state.lock().unwrap();
        state.record = Some(PathBuf::from("fixture.log"));
        state.stopping = true;
    }
    assert!(!job.done().unwrap());
    assert!(job.promote().is_err());
    assert!(!job.published().unwrap());
    job.state.lock().unwrap().stopping = false;
    job.cancellation.cancel();
    assert!(job.promote().is_err());
}

#[tokio::test]
async fn abandoned_launches_settle_and_never_hang_shutdown() {
    let jobs = jobs();
    let prepared = jobs.prepare_process("not started", false).unwrap();
    let job = prepared.job.clone();
    drop(prepared);
    assert!(job.done().unwrap());
    assert!(
        job.snapshot().unwrap()["status"]
            .as_str()
            .unwrap()
            .contains("abandoned")
    );
    tokio::time::timeout(Duration::from_secs(1), jobs.shutdown())
        .await
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn promoted_process_clears_foreground_timeout_and_reaps_before_collection() {
    use xal_services::shell::{ShellManager, ShellRequest};
    let root = std::env::temp_dir().join(format!(
        "xal-jobs-{}",
        xal_services::credentials::new_id().unwrap()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let manager = ShellManager::new();
    let jobs = Jobs::new(
        Some(root.clone()),
        Arc::new(Redactor::new(vec!["fixture-secret".into()]).unwrap()),
    );
    let command = "sleep 0.2; printf fixture-secret; printf done";
    let prepared = jobs.prepare_process(command, false).unwrap();
    let execution = manager
        .execute(ShellRequest {
            session_id: "fixture".into(),
            sandbox_id: "plain".into(),
            command: command.into(),
            cwd: root.to_string_lossy().into_owned(),
            persistent_launch: vec!["/bin/sh".into(), "-s".into()],
            isolated_launch: vec!["/bin/sh".into(), "-c".into(), command.into()],
            environment: std::env::vars()
                .map(|(name, value)| xal_services::process::EnvironmentVariable { name, value })
                .collect(),
        })
        .unwrap();
    execution.set_timeout(100);
    let job = jobs.start_process(prepared, execution, Some(1)).unwrap();
    job.promote().unwrap();
    tokio::time::timeout(Duration::from_secs(5), job.wait(&Cancellation::default()))
        .await
        .unwrap()
        .unwrap();
    let output = jobs
        .collect(&job.id, Duration::ZERO, &Cancellation::default())
        .await
        .unwrap();
    assert!(output.contains("done"), "{output}");
    assert!(!output.contains("fixture-secret"));
    assert!(!output.contains("timed out"));
    assert!(jobs.deliveries().unwrap().is_empty());
    jobs.shutdown().await.unwrap();
    manager.shutdown_all().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn persistent_activity_and_terminal_deliveries_keep_waits_and_finality_consistent() {
    let jobs = jobs();
    jobs.input_pending.store(true, Ordering::Release);
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            jobs.schedule(30_000, &Cancellation::default())
        )
        .await
        .unwrap()
        .unwrap()
        .contains("activity")
    );
    jobs.input_pending.store(false, Ordering::Release);
    assert!(!jobs.available().unwrap());
    let job = jobs
        .create(
            Kind::Agent {
                task: "task".into(),
            },
            true,
        )
        .unwrap();
    let question = job.question();
    assert!(jobs.pending_activity().unwrap());
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            jobs.collect(&job.id, Duration::from_secs(60), &Cancellation::default())
        )
        .await
        .unwrap()
        .unwrap()
        .contains("running")
    );
    drop(question);
    assert!(!jobs.pending_activity().unwrap());
    job.append("report").unwrap();
    job.finish(Status::Completed, "completed".into()).unwrap();
    assert!(jobs.unsettled().unwrap());
    let deliveries = jobs.deliveries().unwrap();
    assert!(jobs.unsettled().unwrap());
    assert!(!jobs.running().unwrap());
    jobs.delivered(&deliveries[0].0, true).unwrap();
    assert!(!jobs.unsettled().unwrap());
    assert!(
        jobs.collect(&job.id, Duration::ZERO, &Cancellation::default())
            .await
            .unwrap()
            .contains("already collected")
    );
    job.state.lock().unwrap().finished_at = Some(0);
    for _ in 0..150 {
        let job = jobs
            .create(
                Kind::Process {
                    command: "foreground".into(),
                },
                false,
            )
            .unwrap();
        job.finish(Status::Completed, "done".into()).unwrap();
    }
    assert!(jobs.available().unwrap());
    assert!(jobs.has_agents().unwrap());
    assert_eq!(jobs.list().unwrap().len(), 2);
    jobs.shutdown().await.unwrap();
}
