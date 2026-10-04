#[cfg(test)]
mod tests;
mod tools;
pub use tools::Tools;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;
use xal_services::process::ProcessTermination;
use xal_services::redactor::Redactor;
use xal_services::shell::ShellExecution;
use xal_services::storage::create_secure;

use crate::{Cancellation, Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Running,
    Completed,
    Failed,
    Interrupted,
    TimedOut,
}

#[derive(Clone, Copy, PartialEq)]
enum Delivery {
    None,
    Reserved,
    Pending,
    InFlight,
    Delivered,
    Suppressed,
    DeadLettered,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BackgroundResult {
    Process {
        id: String,
        command: String,
        status: Status,
        output: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        record: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        record_capped: Option<bool>,
    },
    Agent {
        id: String,
        task: String,
        status: Status,
        output: String,
    },
}

pub(crate) enum Kind {
    Process { command: String },
    Schedule { duration_ms: u64 },
    Agent { task: String },
}

struct Buffer {
    head: String,
    tail: String,
    omitted: bool,
}
impl Buffer {
    fn new() -> Self {
        Self {
            head: String::new(),
            tail: String::new(),
            omitted: false,
        }
    }
    fn append(&mut self, text: &str) {
        let count = 100_000usize.saturating_sub(self.head.encode_utf16().count());
        let split = prefix(text, count).len();
        self.head.push_str(&text[..split]);
        self.tail.push_str(&text[split..]);
        if self.tail.encode_utf16().count() > 300_000 {
            self.tail = suffix(&self.tail, 300_000).into();
            self.omitted = true;
        }
    }
    fn text(&self) -> String {
        format!(
            "{}{}{}",
            self.head,
            if self.omitted {
                "\n... output omitted ...\n"
            } else {
                ""
            },
            self.tail
        )
    }
}

pub(crate) struct State {
    pub status: Status,
    pub detail: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    published: bool,
    stopping: bool,
    delivery: Delivery,
    history: Buffer,
    pending: String,
    dropped: bool,
    record: Option<PathBuf>,
    capped: bool,
    failure: Option<String>,
    exit_code: Option<i32>,
    signal: Option<String>,
}

pub struct Job {
    pub id: String,
    pub(crate) kind: Kind,
    pub(crate) state: Mutex<State>,
    pub cancellation: Cancellation,
    pub changed: Notify,
    pub(crate) activity: Arc<Notify>,
    questions: Arc<AtomicUsize>,
    collectable_started: Arc<AtomicBool>,
}

impl Job {
    pub(crate) fn append(&self, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let mut state = self.state.lock().map_err(failure)?;
        state.history.append(text);
        state.pending.push_str(text);
        if state.pending.encode_utf16().count() > 256_000 {
            state.pending = suffix(&state.pending, 256_000).into();
            state.dropped = true;
        }
        drop(state);
        self.changed.notify_waiters();
        Ok(())
    }

    pub(crate) fn question(&self) -> QuestionGuard {
        self.questions.fetch_add(1, Ordering::AcqRel);
        QuestionGuard(self.questions.clone())
    }

    pub fn done(&self) -> Result<bool> {
        Ok(self.state.lock().map_err(failure)?.finished_at.is_some())
    }
    pub fn published(&self) -> Result<bool> {
        Ok(self.state.lock().map_err(failure)?.published)
    }
    pub fn promote(&self) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.finished_at.is_some() || state.stopping || self.cancellation.check().is_err() {
            return Err(failure("process has already finished or is stopping"));
        }
        if !matches!(self.kind, Kind::Process { .. }) || state.record.is_none() {
            return Err(failure(
                "only a durably logged foreground process can be promoted",
            ));
        }
        state.published = true;
        self.collectable_started.store(true, Ordering::Release);
        self.changed.notify_waiters();
        Ok(())
    }

    pub(crate) fn finish(&self, status: Status, detail: String) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.finished_at.is_some() {
            return Err(failure("job settled twice"));
        }
        state.status = status;
        state.detail = detail;
        state.finished_at = Some(crate::agent::now()?);
        if state.delivery == Delivery::None {
            state.delivery = if state.published {
                Delivery::Pending
            } else {
                Delivery::Suppressed
            };
        }
        drop(state);
        self.changed.notify_waiters();
        self.activity.notify_waiters();
        Ok(())
    }

    pub async fn wait(&self, cancellation: &Cancellation) -> Result<()> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.done()? {
                return Ok(());
            }
            tokio::select! { () = &mut changed => {}, () = cancellation.cancelled() => return Err(Error::Cancelled) }
        }
    }

    pub fn take_output(&self) -> Result<String> {
        let mut state = self.state.lock().map_err(failure)?;
        let output = std::mem::take(&mut state.pending);
        Ok(if std::mem::take(&mut state.dropped) {
            format!("... older output dropped ...\n{output}")
        } else {
            output
        })
    }

    pub fn output(&self) -> Result<String> {
        let state = self.state.lock().map_err(failure)?;
        if let Some(error) = &state.failure {
            return Err(failure(error));
        }
        let mut text = state.history.text();
        if state.history.omitted
            && let Some(path) = &state.record
        {
            text.push_str(&format!(
                "\nFull log: {}{}",
                path.display(),
                if state.capped { " (capped)" } else { "" }
            ));
        }
        Ok(text)
    }

    pub fn result(&self) -> Result<Option<BackgroundResult>> {
        let state = self.state.lock().map_err(failure)?;
        if state.finished_at.is_none() {
            return Ok(None);
        }
        let text = state.pending.trim_end();
        let output = format!(
            "{}{}\n({})",
            if text.encode_utf16().count() > 12_000 || state.dropped {
                "[Earlier output truncated.]\n"
            } else {
                ""
            },
            suffix(text, 12_000),
            state.detail
        );
        Ok(match &self.kind {
            Kind::Process { command } => Some(BackgroundResult::Process {
                id: self.id.clone(),
                command: command.clone(),
                status: state.status,
                output,
                exit_code: state.exit_code,
                signal: state.signal.clone(),
                record: state
                    .record
                    .as_ref()
                    .filter(|_| state.failure.is_none())
                    .map(|p| p.to_string_lossy().into_owned()),
                record_capped: state
                    .record
                    .as_ref()
                    .filter(|_| state.failure.is_none())
                    .map(|_| state.capped),
            }),
            Kind::Agent { task } => Some(BackgroundResult::Agent {
                id: self.id.clone(),
                task: task.clone(),
                status: state.status,
                output,
            }),
            Kind::Schedule { .. } => None,
        })
    }

    pub fn snapshot(&self) -> Result<Value> {
        let state = self.state.lock().map_err(failure)?;
        let mut value = json!({"id":self.id,"status":state.detail,"startedAt":state.started_at,"done":state.finished_at.is_some()});
        if let Some(finished) = state.finished_at {
            value["finishedAt"] = json!(finished);
        }
        match &self.kind {
            Kind::Process { command } => {
                value["kind"] = json!("process");
                value["command"] = json!(command);
            }
            Kind::Schedule { duration_ms } => {
                value["kind"] = json!("schedule");
                value["durationMs"] = json!(duration_ms);
                value["dueAt"] = json!(state.started_at + duration_ms);
            }
            Kind::Agent { task } => {
                value["kind"] = json!("agent");
                value["task"] = json!(task);
            }
        }
        Ok(value)
    }
}

pub struct Jobs {
    entries: Mutex<BTreeMap<String, Arc<Job>>>,
    monitors: Mutex<Vec<tokio::task::JoinHandle<Result<()>>>>,
    pub activity: Arc<Notify>,
    pub(crate) input_pending: AtomicBool,
    questions: Arc<AtomicUsize>,
    collectable_started: Arc<AtomicBool>,
    agents_started: AtomicBool,
    pub(crate) directory: Option<PathBuf>,
    redactor: Arc<Redactor>,
}

pub struct ProcessJob {
    pub job: Arc<Job>,
    log: Option<File>,
    started: bool,
}

impl Jobs {
    pub(crate) fn new(directory: Option<PathBuf>, redactor: Arc<Redactor>) -> Self {
        Self {
            entries: Mutex::default(),
            monitors: Mutex::default(),
            activity: Arc::default(),
            input_pending: AtomicBool::new(false),
            questions: Arc::default(),
            collectable_started: Arc::default(),
            agents_started: AtomicBool::new(false),
            directory,
            redactor,
        }
    }

    pub(crate) fn create(&self, kind: Kind, published: bool) -> Result<Arc<Job>> {
        self.create_named(kind, published, None)
    }

    pub(crate) fn create_named(
        &self,
        kind: Kind,
        published: bool,
        name: Option<&str>,
    ) -> Result<Arc<Job>> {
        let mut entries = self.entries.lock().map_err(failure)?;
        let now = crate::agent::now()?;
        entries.retain(|_, job| {
            job.state.lock().map_or(true, |state| {
                if !state.published && state.finished_at.is_some() {
                    return false;
                }
                state
                    .finished_at
                    .is_none_or(|at| now.saturating_sub(at) < 300_000)
                    || !matches!(
                        state.delivery,
                        Delivery::Delivered | Delivery::Suppressed | Delivery::DeadLettered
                    )
            })
        });
        if entries.len() >= 128 {
            return Err(failure("session job limit reached"));
        }
        let mut id = match name {
            Some(name) => name.to_owned(),
            None => xal_services::credentials::new_id().map_err(failure)?,
        };
        if let Some(name) = name {
            let mut suffix = 2;
            while entries.contains_key(&id) {
                id = format!("{name}-{suffix}");
                suffix += 1;
            }
        }
        if published && !matches!(kind, Kind::Schedule { .. }) {
            self.collectable_started.store(true, Ordering::Release);
        }
        if matches!(kind, Kind::Agent { .. }) {
            self.agents_started.store(true, Ordering::Release);
        }
        let job = Arc::new(Job {
            id: id.clone(),
            kind,
            state: Mutex::new(State {
                status: Status::Running,
                detail: "running".into(),
                started_at: now,
                finished_at: None,
                published,
                stopping: false,
                delivery: Delivery::None,
                history: Buffer::new(),
                pending: String::new(),
                dropped: false,
                record: None,
                capped: false,
                failure: None,
                exit_code: None,
                signal: None,
            }),
            cancellation: Cancellation::default(),
            changed: Notify::new(),
            activity: self.activity.clone(),
            questions: self.questions.clone(),
            collectable_started: self.collectable_started.clone(),
        });
        entries.insert(id, job.clone());
        Ok(job)
    }

    pub fn prepare_process(&self, command: &str, background: bool) -> Result<ProcessJob> {
        if background && self.directory.is_none() {
            return Err(failure("background log storage is not configured"));
        }
        if let Some(directory) = &self.directory {
            crate::agent::storage::secure_directory(&directory.join("jobs"))?;
        }
        let job = self.create(
            Kind::Process {
                command: self.redactor.redact(command),
            },
            background,
        )?;
        let log = match &self.directory {
            Some(directory) => {
                let path = directory
                    .join("jobs")
                    .join(format!("process-{}.log", job.id));
                match create_secure(&path) {
                    Ok(file) => {
                        job.state.lock().map_err(failure)?.record = Some(path);
                        Some(file)
                    }
                    Err(error) => {
                        self.entries.lock().map_err(failure)?.remove(&job.id);
                        return Err(failure(error));
                    }
                }
            }
            None => None,
        };
        Ok(ProcessJob {
            job,
            log,
            started: false,
        })
    }

    pub fn start_process(
        &self,
        mut prepared: ProcessJob,
        execution: ShellExecution,
        timeout_seconds: Option<u32>,
    ) -> Result<Arc<Job>> {
        let job = prepared.job.clone();
        let mut monitors = self.monitors.lock().map_err(failure)?;
        let redactor = self.redactor.clone();
        prepared.started = true;
        let monitor = tokio::spawn(async move {
            monitor_process(prepared, execution, redactor, timeout_seconds).await
        });
        monitors.push(monitor);
        Ok(job)
    }

    pub(crate) fn track(&self, monitor: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
        self.monitors.lock().map_err(failure)?.push(monitor);
        Ok(())
    }

    pub fn has_agents(&self) -> Result<bool> {
        Ok(self.agents_started.load(Ordering::Acquire))
    }

    pub fn pending_activity(&self) -> Result<bool> {
        if self.input_pending.load(Ordering::Acquire) || self.questions.load(Ordering::Acquire) != 0
        {
            return Ok(true);
        }
        for job in self.list()? {
            if job.state.lock().map_err(failure)?.delivery == Delivery::Pending {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn launch_failed(&self, prepared: ProcessJob, error: &Error) -> Result<()> {
        prepared.job.state.lock().map_err(failure)?.delivery = Delivery::Suppressed;
        prepared.job.finish(Status::Failed, error.to_string())
    }

    pub fn get(&self, id: &str) -> Result<Arc<Job>> {
        self.entries
            .lock()
            .map_err(failure)?
            .get(id)
            .cloned()
            .ok_or_else(|| failure(format!("no owned background job with id {id:?}")))
    }
    pub(crate) fn owns(&self, job: &Arc<Job>) -> Result<bool> {
        Ok(self
            .entries
            .lock()
            .map_err(failure)?
            .get(&job.id)
            .is_some_and(|owned| Arc::ptr_eq(owned, job)))
    }
    pub fn running(&self) -> Result<bool> {
        for job in self.list()? {
            let state = job.state.lock().map_err(failure)?;
            if state.published
                && state.finished_at.is_none()
                && !matches!(job.kind, Kind::Schedule { .. })
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn list(&self) -> Result<Vec<Arc<Job>>> {
        Ok(self
            .entries
            .lock()
            .map_err(failure)?
            .values()
            .cloned()
            .collect())
    }
    pub fn available(&self) -> Result<bool> {
        Ok(self.collectable_started.load(Ordering::Acquire))
    }
    pub fn unsettled(&self) -> Result<bool> {
        for job in self.list()? {
            let state = job.state.lock().map_err(failure)?;
            if state.published
                && !matches!(job.kind, Kind::Schedule { .. })
                && (state.finished_at.is_none()
                    || matches!(
                        state.delivery,
                        Delivery::Reserved | Delivery::Pending | Delivery::InFlight
                    ))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn deliveries(&self) -> Result<Vec<(Arc<Job>, BackgroundResult)>> {
        let mut result = Vec::new();
        for job in self.list()? {
            let deliver = {
                let mut state = job.state.lock().map_err(failure)?;
                if state.delivery == Delivery::Pending && !matches!(job.kind, Kind::Schedule { .. })
                {
                    state.delivery = Delivery::InFlight;
                    true
                } else {
                    false
                }
            };
            if deliver && let Some(value) = job.result()? {
                result.push((job, value));
            }
        }
        Ok(result)
    }

    pub fn delivered(&self, job: &Job, accepted: bool) -> Result<()> {
        let mut state = job.state.lock().map_err(failure)?;
        if state.delivery != Delivery::InFlight {
            return Err(failure("background delivery lost ownership"));
        }
        if accepted {
            state.pending.clear();
            state.dropped = false;
        }
        state.delivery = if accepted {
            Delivery::Delivered
        } else {
            Delivery::DeadLettered
        };
        Ok(())
    }

    pub async fn collect(
        &self,
        id: &str,
        wait: Duration,
        cancellation: &Cancellation,
    ) -> Result<String> {
        let job = self.get(id)?;
        let reservation = Reservation::new(job.clone())?;
        let started = Instant::now();
        loop {
            let changed = job.changed.notified();
            let activity = self.activity.notified();
            tokio::pin!(changed, activity);
            changed.as_mut().enable();
            activity.as_mut().enable();
            if self.pending_activity()?
                || job.done()?
                || !job.state.lock().map_err(failure)?.pending.is_empty()
                || started.elapsed() >= wait
            {
                break;
            }
            tokio::select! { () = &mut changed => {}, () = &mut activity => break, () = cancellation.cancelled() => return Err(Error::Cancelled), () = tokio::time::sleep(wait.saturating_sub(started.elapsed())) => break }
        }
        let mut state = job.state.lock().map_err(failure)?;
        let done = state.finished_at.is_some();
        let value = match &job.kind {
            Kind::Process { .. } => {
                let mut value = json!({"pending":state.pending,"dropped":state.dropped,"done":done,"status":state.detail});
                if let Some(message) = &state.failure {
                    value["record"] = json!({"status":"failed","message":message});
                } else if let Some(path) = &state.record {
                    value["record"] =
                        json!({"status":"saved","path":path,"complete":!state.capped});
                }
                xal_services::tool_runtime::process_output(&value).map_err(failure)?
            }
            Kind::Agent { .. } => {
                json!({"output":format!("{}\n({})", if state.pending.is_empty() { "(report already collected)" } else { &state.pending }, state.detail)})
            }
            Kind::Schedule { .. } => json!({"output":format!("{} ({})", job.id, state.detail)}),
        };
        let output = value["output"]
            .as_str()
            .ok_or_else(|| failure("invalid collected output"))?
            .to_owned();
        state.pending.clear();
        state.dropped = false;
        drop(state);
        reservation.finish(done)?;
        Ok(output)
    }

    pub async fn stop(&self, id: &str) -> Result<()> {
        let job = self.get(id)?;
        job.cancellation.cancel();
        job.wait(&Cancellation::default()).await
    }

    pub async fn shutdown(&self) -> Result<()> {
        let jobs = self.list()?;
        for job in &jobs {
            if !job.done()? {
                job.cancellation.cancel();
            }
        }
        let monitors = std::mem::take(&mut *self.monitors.lock().map_err(failure)?);
        let mut errors = Vec::new();
        for monitor in monitors {
            match monitor.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error.to_string()),
                Err(error) => errors.push(error.to_string()),
            }
        }
        for job in jobs {
            if !job.done()? {
                if matches!(job.kind, Kind::Schedule { .. }) {
                    job.wait(&Cancellation::default()).await?;
                } else {
                    job.finish(
                        Status::Failed,
                        "job monitor stopped without settling".into(),
                    )?;
                    errors.push(format!("job {} stopped without settling", job.id));
                }
            }
        }
        if !errors.is_empty() {
            return Err(failure(errors.join("\n")));
        }
        Ok(())
    }

    pub async fn schedule(&self, duration_ms: u64, cancellation: &Cancellation) -> Result<String> {
        if !(1..=43_200_000).contains(&duration_ms) {
            return Err(failure("invalid scheduler duration"));
        }
        let job = self.create(Kind::Schedule { duration_ms }, true)?;
        let guard = ScheduleGuard(job.clone());
        let started = Instant::now();
        let activity = self.activity.notified();
        tokio::pin!(activity);
        activity.as_mut().enable();
        let outcome = if self.pending_activity()? {
            "activity"
        } else {
            tokio::select! { biased; () = cancellation.cancelled() => "interrupted", () = job.cancellation.cancelled() => "canceled", () = &mut activity => "activity", () = tokio::time::sleep(Duration::from_millis(duration_ms)) => "completed" }
        };
        job.state.lock().map_err(failure)?.delivery = Delivery::Suppressed;
        job.finish(
            if ["interrupted", "canceled"].contains(&outcome) {
                Status::Interrupted
            } else {
                Status::Completed
            },
            outcome.into(),
        )?;
        drop(guard);
        let result = xal_services::tool_runtime::scheduler_finalize(
            &json!({"elapsedSeconds":started.elapsed().as_secs_f64(),"outcome":outcome}),
        )
        .map_err(failure)?;
        result["output"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| failure("invalid scheduler output"))
    }
}

struct Reservation {
    job: Arc<Job>,
    owned: bool,
}
impl Reservation {
    fn new(job: Arc<Job>) -> Result<Self> {
        let mut state = job.state.lock().map_err(failure)?;
        if matches!(state.delivery, Delivery::Reserved | Delivery::InFlight) {
            return Err(failure("job output already has a collector"));
        }
        let owned = matches!(state.delivery, Delivery::None | Delivery::Pending);
        if owned {
            state.delivery = Delivery::Reserved;
        }
        drop(state);
        Ok(Self { job, owned })
    }
    fn finish(mut self, done: bool) -> Result<()> {
        if self.owned && done {
            self.job.state.lock().map_err(failure)?.delivery = Delivery::Suppressed;
            self.owned = false;
        }
        Ok(())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.owned
            && let Ok(mut state) = self.job.state.lock()
        {
            state.delivery = if state.finished_at.is_some() {
                Delivery::Pending
            } else {
                Delivery::None
            };
            self.job.activity.notify_waiters();
        }
    }
}

async fn monitor_process(
    mut prepared: ProcessJob,
    execution: ShellExecution,
    redactor: Arc<Redactor>,
    timeout_seconds: Option<u32>,
) -> Result<()> {
    let job = &prepared.job;
    let mut wait = execution.wait();
    let mut completion = tokio::task::spawn_blocking(move || wait.compute());
    let mut redaction = redactor.stream();
    let mut pending = Vec::new();
    let mut saved = 0usize;
    let mut completed = false;
    let mut stopping = false;
    let timeout = tokio::time::sleep(Duration::from_secs(
        u64::from(timeout_seconds.unwrap_or(0)) + 1,
    ));
    tokio::pin!(timeout);
    let grace = tokio::time::sleep(Duration::from_secs(2));
    tokio::pin!(grace);
    let result: Result<ProcessTermination> = async {
        loop {
            let changed = execution.activity().notified(); let promoted = job.changed.notified();
            tokio::pin!(changed, promoted); changed.as_mut().enable(); promoted.as_mut().enable();
            if job.published()? { execution.clear_timeout(); }
            pending.extend(execution.drain());
            append_process(job, &mut prepared.log, &mut pending, &mut redaction, &mut saved, false)?;
            tokio::select! {
                biased;
                () = job.cancellation.cancelled(), if !stopping => { execution.terminate(); stopping = true; grace.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(2)); }
                () = &mut grace, if stopping => { execution.kill(); let result = (&mut completion).await; completed = true; return result.map_err(failure)?.map_err(failure); }
                () = &mut timeout, if timeout_seconds.is_some() && !job.published()? && !stopping => {
                    {
                        let mut state = job.state.lock().map_err(failure)?;
                        if state.published { execution.clear_timeout(); continue; }
                        state.stopping = true;
                        execution.kill();
                    }
                    let result = (&mut completion).await; completed = true; return result.map_err(failure)?.map_err(failure);
                }
                result = &mut completion => { completed = true; return result.map_err(failure)?.map_err(failure); },
                () = &mut changed => {},
                () = &mut promoted => {},
            }
        }
    }.await;
    let result = if result.is_err() {
        execution.kill();
        let cleanup = if !completed {
            (&mut completion)
                .await
                .map_err(failure)
                .and_then(|result| result.map_err(failure))
                .map(|_| ())
        } else {
            Ok(())
        };
        let reaped = execution.kill_and_wait().map_err(failure);
        match (result, cleanup.and(reaped)) {
            (result, Ok(())) => result,
            (Err(error), Err(cleanup)) => Err(failure(format!(
                "{error}; process cleanup failed: {cleanup}"
            ))),
            (Ok(_), Err(error)) => Err(error),
        }
    } else {
        result
    };
    pending.extend(execution.drain());
    let flushed = append_process(
        job,
        &mut prepared.log,
        &mut pending,
        &mut redaction,
        &mut saved,
        true,
    )
    .and_then(|()| {
        prepared
            .log
            .as_ref()
            .map_or(Ok(()), |log| log.sync_all().map_err(failure))
    });
    let (status, detail) = match (result, flushed) {
        (Ok(termination), Ok(())) => {
            let mut state = job.state.lock().map_err(failure)?;
            state.exit_code = termination.exit_code;
            state.signal = termination.signal;
            if job.cancellation.check().is_err() {
                (Status::Interrupted, "interrupted".into())
            } else if execution.timed_out() {
                (
                    Status::Failed,
                    format!(
                        "timed out after {}s",
                        timeout_seconds
                            .ok_or_else(|| failure("timed-out process has no timeout"))?
                    ),
                )
            } else if termination.status == "signaled" {
                (Status::Interrupted, "terminated by signal".into())
            } else {
                (
                    if termination.exit_code == Some(0) {
                        Status::Completed
                    } else {
                        Status::Failed
                    },
                    format!("exit code {}", termination.exit_code.unwrap_or(-1)),
                )
            }
        }
        (result, flushed) => {
            let detail = [
                result.err().map(|e| e.to_string()),
                flushed
                    .err()
                    .map(|e| format!("log persistence failed: {e}")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("; ");
            job.state.lock().map_err(failure)?.failure = Some(detail.clone());
            (Status::Failed, detail)
        }
    };
    job.finish(status, detail)
}

fn append_process(
    job: &Job,
    log: &mut Option<File>,
    pending: &mut Vec<u8>,
    redactor: &mut xal_services::redactor::RedactedStream<'_>,
    saved: &mut usize,
    final_chunk: bool,
) -> Result<()> {
    let mut length = 0;
    while length < pending.len() {
        match std::str::from_utf8(&pending[length..]) {
            Ok(_) => {
                length = pending.len();
                break;
            }
            Err(error) => {
                length += error.valid_up_to();
                match error.error_len() {
                    Some(invalid) => length += invalid,
                    None => break,
                }
            }
        }
    }
    if final_chunk {
        length = pending.len();
    }
    let mut text = redactor.write(&String::from_utf8_lossy(&pending[..length]));
    pending.drain(..length);
    if final_chunk {
        text.push_str(&redactor.end());
    }
    let available = (64 * 1024 * 1024usize).saturating_sub(*saved);
    let writable = &text[..text.floor_char_boundary(available.min(text.len()))];
    if !writable.is_empty() {
        if let Some(log) = log {
            log.write_all(writable.as_bytes()).map_err(failure)?;
        }
        *saved += writable.len();
    }
    if writable.len() != text.len() {
        job.state.lock().map_err(failure)?.capped = true;
    }
    job.append(&text)
}

pub(crate) fn prefix(text: &str, maximum: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > maximum {
            return &text[..index];
        }
    }
    text
}
fn suffix(text: &str, maximum: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > maximum {
            return &text[index + c.len_utf8()..];
        }
    }
    text
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

struct ScheduleGuard(Arc<Job>);
impl Drop for ScheduleGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock()
            && state.finished_at.is_none()
        {
            state.status = Status::Interrupted;
            state.detail = "wait dropped".into();
            state.finished_at = Some(state.started_at);
            state.delivery = Delivery::Suppressed;
            self.0.changed.notify_waiters();
            self.0.activity.notify_waiters();
        }
    }
}

impl Drop for Jobs {
    fn drop(&mut self) {
        if let Ok(entries) = self.entries.get_mut() {
            for job in entries.values() {
                job.cancellation.cancel();
            }
        }
    }
}

impl BackgroundResult {
    pub fn redact(&mut self, redactor: &Redactor) {
        match self {
            Self::Process {
                command,
                output,
                record,
                signal,
                ..
            } => {
                *command = redactor.redact(command);
                *output = redactor.redact(output);
                *record = record.as_ref().map(|s| redactor.redact(s));
                *signal = signal.as_ref().map(|s| redactor.redact(s));
            }
            Self::Agent { task, output, .. } => {
                *task = redactor.redact(task);
                *output = redactor.redact(output);
            }
        }
    }
    pub fn message(&self) -> String {
        match self {
            Self::Process {
                id,
                command,
                status,
                output,
                record,
                record_capped,
                ..
            } => format!(
                "## {id} · {status:?}\nCommand: {}\n\n{output}{}",
                command.lines().next().unwrap_or_default(),
                record.as_ref().map_or_else(String::new, |path| format!(
                    "\nFull log: {path}{}",
                    if *record_capped == Some(true) {
                        " (capped)"
                    } else {
                        ""
                    }
                ))
            ),
            Self::Agent {
                id,
                task,
                status,
                output,
            } => format!(
                "## {id} · {status:?}\nTask: {}\n\n{output}",
                task.lines().next().unwrap_or_default()
            ),
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.started
            && self.job.done().is_ok_and(|done| !done)
            && let Err(error) = self
                .job
                .finish(Status::Failed, "process launch was abandoned".into())
        {
            eprintln!("process launch cleanup failed: {error}");
        }
    }
}

pub(crate) struct QuestionGuard(Arc<AtomicUsize>);
impl Drop for QuestionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
