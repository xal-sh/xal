use super::*;
use crate::{Host, SessionKind};

struct Fixture {
    root: PathBuf,
    host: Host,
    service: Arc<Service>,
}
impl Fixture {
    async fn new(factory: Factory) -> Self {
        let root = std::env::temp_dir().join(format!(
            "xal-task-{}",
            xal_services::credentials::new_id().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let redactor = Arc::new(Redactor::new(vec!["fixture-secret".into()]).unwrap());
        let settings = xal_services::settings::Settings::parse(
            json!({"agents":{"maxConcurrent":1,"maxTurns":2,"timeoutMinutes":0}})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let service = Service::new(settings.agents, factory, redactor.clone());
        let mut host = Host::new(Vec::new(), Cancellation::default());
        host.output_policy(redactor, root.clone());
        host.task_service = Some(service.clone());
        host.start().await.unwrap();
        Self {
            root,
            host,
            service,
        }
    }
    fn session(&self, id: &str) -> Session {
        self.host
            .session(
                id.into(),
                self.root.clone(),
                SessionKind::Interactive,
                false,
            )
            .unwrap()
    }
    fn spawn(&self, session: &Session, name: &str) -> Arc<Handle> {
        let settings = xal_services::settings::Settings::parse(&crate::JsonObject::new()).unwrap();
        let id = self
            .service
            .spawn(
                "Shared context".into(),
                Assignment {
                    name: Some(name.into()),
                    task: "Complete assignment fixture-secret".into(),
                    access: Access::Read,
                    isolation: Isolation::Shared,
                    thinking: None,
                },
                session.clone(),
                Options {
                    provider: "fixture".into(),
                    profile: Some("original-account".into()),
                    model: "model".into(),
                    mode: "normal".into(),
                    instructions: "instructions".into(),
                    thinking: None,
                    context_window: 100_000,
                    image_input: false,
                    summary_target: None,
                    compaction_limit: None,
                    output_schema: None,
                    artifacts: self.root.clone(),
                },
                crate::permissions::Permissions::load(&settings, &self.root, &self.root, "normal")
                    .unwrap(),
            )
            .unwrap();
        self.service.get(&session.id, &id).unwrap()
    }
    async fn close(mut self) {
        self.host.shutdown().await;
        assert!(self.host.failures().is_empty());
        drop(self.host);
        drop(self.service);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn global_queue_extension_and_cleanup_preserve_records_even_before_start() {
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let fixture = Fixture::new(Arc::new(move |invocation| {
        invocation.handle.event(AgentEvent::TextDelta {
            text: "partial fixture-secret".into(),
        })?;
        signal.notify_one();
        while invocation.handle.job.cancellation.check().is_ok() {
            std::thread::sleep(Duration::from_millis(2));
        }
        Err(Error::Cancelled)
    }))
    .await;
    let one = fixture.session("one");
    let two = fixture.session("two");
    let first = fixture.spawn(&one, "first");
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    let queued = fixture.spawn(&two, "queued");
    assert!(queued.snapshot().unwrap()["runningAt"].is_null());
    assert!(queued.send("queued guidance").unwrap().contains("queued"));
    assert!(queued.extend(100).unwrap().contains("102 turns"));
    assert!(queued.extend(100).unwrap().contains("202 turns"));
    assert!(queued.extend(101).is_err());
    assert!(!first.limit_reached().unwrap());
    first.cycle().unwrap();
    first.cycle().unwrap();
    assert!(!first.limit_reached().unwrap());
    first.cycle().unwrap();
    assert!(first.limit_reached().unwrap());
    assert_eq!(
        first.supervision_wait(Duration::from_secs(600)).unwrap(),
        Duration::from_secs(600)
    );
    assert!(first.snapshot().unwrap()["deadlineAt"].is_null());
    tokio::time::timeout(Duration::from_secs(2), two.jobs.stop(&queued.job.id))
        .await
        .unwrap()
        .unwrap();
    assert!(queued.state.lock().unwrap().record.is_none());
    let record = std::fs::read_to_string(&queued.record).unwrap();
    assert!(record.contains("Shared context"));
    assert!(record.contains("Interrupted"));
    assert!(!record.contains("fixture-secret"));
    tokio::time::timeout(Duration::from_secs(2), one.jobs.stop(&first.job.id))
        .await
        .unwrap()
        .unwrap();
    let log = std::fs::read_to_string(&first.log).unwrap();
    assert!(log.contains("partial"));
    let report = one
        .jobs
        .collect(&first.job.id, Duration::ZERO, &Cancellation::default())
        .await
        .unwrap();
    assert!(!report.contains("fixture-secret"));
    assert!(!log.contains("fixture-secret"));
    fixture.host.dispose_session(&one).await.unwrap();
    assert!(fixture.service.get("one", &first.job.id).is_err());
    drop(first);
    drop(queued);
    fixture.close().await;
}

#[tokio::test]
async fn incomplete_records_keep_a_bounded_tail_and_retained_jobs_keep_their_handles() {
    let fixture = Fixture::new(Arc::new(|invocation| {
        invocation.handle.event(AgentEvent::AssistantMessage {
            text: "old report fixture-secret".into(),
        })?;
        invocation.handle.event(AgentEvent::ToolFinished {
            call_id: "call".into(),
            tool: "read".into(),
            title: "read".into(),
            read_only: true,
            output: format!("{}latest evidence fixture-secret", "😀".repeat(300_000)),
            denial: None,
        })?;
        Err(Error::Cancelled)
    }))
    .await;
    let parent = fixture.session("parent");
    let task = fixture.spawn(&parent, "retained");
    task.job.wait(&Cancellation::default()).await.unwrap();
    let markdown = std::fs::read_to_string(&task.record).unwrap();
    assert!(markdown.len() < 1_100_000);
    assert!(markdown.contains("Incomplete transcript tail:"));
    assert!(markdown.contains("latest evidence"));
    assert!(!markdown.contains("fixture-secret"));
    task.job.state.lock().unwrap().finished_at = Some(0);
    let another_parent = fixture.session("another");
    let another = fixture.spawn(&another_parent, "another");
    assert!(fixture.service.get("parent", &task.job.id).is_ok());
    assert!(parent.jobs.get(&task.job.id).is_ok());
    another.job.wait(&Cancellation::default()).await.unwrap();
    drop(task);
    drop(another);
    fixture.close().await;
}

#[tokio::test]
async fn child_questions_wake_existing_waits_and_become_unavailable_after_one_correction() {
    let fixture = Fixture::new(Arc::new(|invocation| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(failure)?
            .block_on(
                invocation
                    .handle
                    .ask("Which choice?", &invocation.handle.job.cancellation),
            )
    }))
    .await;
    let parent = fixture.session("parent");
    let task = fixture.spawn(&parent, "question");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let changed = parent.jobs.activity.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if fixture.service.pending(&parent.id).unwrap() {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    let questions = fixture.service.questions(&parent.id).unwrap();
    assert_eq!(questions.len(), 1);
    assert!(parent.jobs.pending_activity().unwrap());
    assert!(
        fixture
            .service
            .instructions(&parent.id)
            .unwrap()
            .contains("job_send")
    );
    fixture
        .service
        .acknowledge_questions(&parent.id, &questions)
        .unwrap();
    assert!(fixture.service.questions(&parent.id).unwrap().is_empty());
    assert!(fixture.service.unanswered(&parent.id).unwrap());
    assert!(!fixture.service.unanswered(&parent.id).unwrap());
    tokio::time::timeout(
        Duration::from_secs(2),
        task.job.wait(&Cancellation::default()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(fixture.service.instructions(&parent.id).unwrap().is_empty());
    let report = parent
        .jobs
        .collect(&task.job.id, Duration::ZERO, &Cancellation::default())
        .await
        .unwrap();
    assert!(report.contains("Parent unavailable"));
    assert!(
        std::fs::read_to_string(&task.record)
            .unwrap()
            .contains("Final report")
    );
    drop(task);
    fixture.close().await;
}
