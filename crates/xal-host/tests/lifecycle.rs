use std::sync::{Arc, Mutex};

use xal_host::{Call, Cancellation, Error, Host, Phase, Plugin, Registration, Result};

type Trace = Arc<Mutex<Vec<String>>>;

struct Probe {
    name: &'static str,
    command: &'static str,
    trace: Trace,
    failure: Option<Phase>,
    cancel: Option<Phase>,
}

impl Probe {
    fn new(name: &'static str, trace: &Trace) -> Self {
        Self {
            name,
            command: name,
            trace: trace.clone(),
            failure: None,
            cancel: None,
        }
    }

    fn step(&self, phase: Phase) -> Result<()> {
        self.trace
            .lock()
            .unwrap()
            .push(format!("{}:{phase:?}", self.name));
        if self.failure == Some(phase) {
            return Err(Error::Failed("fixture failure".into()));
        }
        Ok(())
    }
}

impl Plugin for Probe {
    fn name(&self) -> &str {
        self.name
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let name = self.name;
        registration.command(self.command, "fixture", move |args, cancellation| {
            if args == ["cancel"] {
                cancellation.cancel();
            }
            Ok(name.into())
        })?;
        for index in 0..2 {
            let trace = self.trace.clone();
            let cancellation = registration.cancellation();
            let fail = self.failure == Some(Phase::Dispose);
            registration.own(move || {
                assert_eq!(cancellation.check(), Err(Error::Cancelled));
                trace.lock().unwrap().push(format!("{name}:Dispose{index}"));
                if fail {
                    return Err(Error::Failed("dispose failed".into()));
                }
                Ok(())
            });
        }
        if self.cancel == Some(Phase::Register) {
            registration.cancellation().cancel();
        }
        self.step(Phase::Register)
    }

    fn bootstrap<'a>(&'a mut self, registration: &'a mut Registration) -> Call<'a, ()> {
        Box::pin(async move {
            registration.command(&format!("{}-ready", self.name), "late command", |_, _| {
                Ok("ready".into())
            })?;
            if self.cancel == Some(Phase::Bootstrap) {
                registration.cancellation().cancel();
            }
            self.step(Phase::Bootstrap)
        })
    }

    fn shutdown(&mut self) -> Call<'_, ()> {
        Box::pin(async move { self.step(Phase::Shutdown) })
    }
}

#[tokio::test]
async fn stages_bootstrap_commands_and_shuts_down_once_in_reverse_order() {
    let trace = Trace::default();
    let mut host = Host::new(
        vec![
            Box::new(Probe::new("first", &trace)),
            Box::new(Probe::new("second", &trace)),
        ],
        Cancellation::default(),
    );
    assert!(host.commands().is_empty());
    assert!(host.execute("first", &[]).await.is_err());
    host.start().await.unwrap();
    assert_eq!(host.execute("first", &[]).await.unwrap(), "first");
    assert_eq!(host.execute("second-ready", &[]).await.unwrap(), "ready");
    assert!(host.start().await.is_err());
    host.shutdown().await;
    host.shutdown().await;
    assert!(host.commands().is_empty());
    assert!(host.failures().is_empty());
    assert!(host.start().await.is_err());
    assert_eq!(
        *trace.lock().unwrap(),
        [
            "first:Register",
            "second:Register",
            "first:Bootstrap",
            "second:Bootstrap",
            "second:Shutdown",
            "second:Dispose1",
            "second:Dispose0",
            "first:Shutdown",
            "first:Dispose1",
            "first:Dispose0",
        ]
    );
}

#[tokio::test]
async fn failed_registration_or_bootstrap_never_exposes_partial_commands() {
    for phase in [Phase::Register, Phase::Bootstrap] {
        let trace = Trace::default();
        let mut failed = Probe::new("failed", &trace);
        failed.failure = Some(phase);
        let mut host = Host::new(
            vec![Box::new(failed), Box::new(Probe::new("healthy", &trace))],
            Cancellation::default(),
        );
        assert!(host.start().await.is_err());
        assert!(host.execute("failed", &[]).await.is_err());
        assert!(host.execute("failed-ready", &[]).await.is_err());
        assert_eq!(host.execute("healthy", &[]).await.unwrap(), "healthy");
        assert_eq!(host.failures()[0].phase, phase);
        host.shutdown().await;
        assert_eq!(
            trace
                .lock()
                .unwrap()
                .iter()
                .filter(|step| *step == "failed:Dispose0")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn duplicate_commands_and_plugin_names_roll_back_only_the_failed_owner() {
    for duplicate_name in [false, true] {
        let trace = Trace::default();
        let mut duplicate = Probe::new(if duplicate_name { "first" } else { "second" }, &trace);
        duplicate.command = "first";
        let mut host = Host::new(
            vec![Box::new(Probe::new("first", &trace)), Box::new(duplicate)],
            Cancellation::default(),
        );
        assert!(host.start().await.is_err());
        assert_eq!(host.execute("first", &[]).await.unwrap(), "first");
        assert_eq!(host.commands().len(), 2);
        assert_eq!(host.failures()[0].phase, Phase::Register);
        host.shutdown().await;
    }
}

#[tokio::test]
async fn cancellation_rolls_back_startup_and_prevents_command_success() {
    for phase in [Phase::Register, Phase::Bootstrap] {
        let trace = Trace::default();
        let mut cancelled = Probe::new("cancelled", &trace);
        cancelled.cancel = Some(phase);
        let mut host = Host::new(vec![Box::new(cancelled)], Cancellation::default());
        assert!(host.start().await.is_err());
        assert!(host.commands().is_empty());
        assert_eq!(host.failures()[0].error, Error::Cancelled);
        assert!(trace.lock().unwrap().contains(&"cancelled:Dispose0".into()));
        host.shutdown().await;
    }
    let trace = Trace::default();
    let cancellation = Cancellation::default();
    let mut host = Host::new(
        vec![Box::new(Probe::new("run", &trace))],
        cancellation.clone(),
    );
    host.start().await.unwrap();
    assert_eq!(
        host.execute("run", &["cancel".into()]).await,
        Err(Error::Cancelled)
    );
    cancellation.cancel();
    assert_eq!(host.execute("run", &[]).await, Err(Error::Cancelled));
    host.shutdown().await;
}

#[tokio::test]
async fn cleanup_failures_remain_visible_and_do_not_stop_other_disposers() {
    for phase in [Phase::Shutdown, Phase::Dispose] {
        let trace = Trace::default();
        let mut failed = Probe::new("failed", &trace);
        failed.failure = Some(phase);
        let mut host = Host::new(
            vec![Box::new(Probe::new("healthy", &trace)), Box::new(failed)],
            Cancellation::default(),
        );
        host.start().await.unwrap();
        host.shutdown().await;
        assert!(host.failures().iter().all(|failure| failure.phase == phase));
        assert_eq!(
            host.failures().len(),
            if phase == Phase::Dispose { 2 } else { 1 }
        );
        assert!(trace.lock().unwrap().contains(&"healthy:Dispose0".into()));
        assert!(trace.lock().unwrap().contains(&"failed:Dispose0".into()));
    }
}

#[tokio::test]
async fn hosts_do_not_share_registrations_or_cancellation() {
    let trace = Trace::default();
    let mut first = Host::new(
        vec![Box::new(Probe::new("command", &trace))],
        Cancellation::default(),
    );
    let mut second = Host::new(
        vec![Box::new(Probe::new("command", &trace))],
        Cancellation::default(),
    );
    first.start().await.unwrap();
    second.start().await.unwrap();
    first.shutdown().await;
    assert_eq!(second.execute("command", &[]).await.unwrap(), "command");
    second.shutdown().await;
}
