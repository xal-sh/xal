#[cfg(test)]
mod tests;
mod tools;
pub use tools::Tools;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, oneshot};
use xal_services::redactor::Redactor;
use xal_services::settings::AgentSettings;

use crate::agent::{AgentEvent, Control, Options};
use crate::jobs::{Job, Kind, Status};
use crate::{Cancellation, Error, Result, Session};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Write,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    Shared,
    Worktree,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub name: Option<String>,
    pub task: String,
    pub access: Access,
    pub isolation: Isolation,
    pub thinking: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub request_id: String,
    pub job_id: String,
    pub question: String,
}

struct Pending {
    question: Question,
    delivered: bool,
    corrected: bool,
    answer: oneshot::Sender<Option<String>>,
    _activity: crate::jobs::QuestionGuard,
}

struct State {
    control: Option<Control>,
    guidance: Vec<String>,
    pending: Option<Pending>,
    running_at: Option<u64>,
    deadline_at: Option<u64>,
    turns: u32,
    budget: u32,
    notice_at: u32,
    provider_requests: u32,
    tool_count: u32,
    activity: String,
    last_activity: u64,
    record: Option<File>,
    log: Option<File>,
    assignment: String,
    workspace: Option<String>,
    transcript: String,
    last_report: String,
    timeout: Duration,
    bytes: usize,
    capped: bool,
}

pub struct Handle {
    pub job: Arc<Job>,
    owner: String,
    jobs: std::sync::Weak<crate::jobs::Jobs>,
    pub record: PathBuf,
    pub log: PathBuf,
    state: Mutex<State>,
    redactor: Arc<Redactor>,
}

impl Handle {
    pub fn bind(&self, control: Control) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        for guidance in &state.guidance {
            control.queue(crate::agent::Input {
                text: guidance.clone(),
                images: Vec::new(),
            })?;
        }
        state.guidance.clear();
        state.control = Some(control);
        Ok(())
    }

    pub fn send(&self, message: &str) -> Result<String> {
        message_length(message)?;
        let message = self.redactor.redact(message.trim());
        let mut state = self.state.lock().map_err(failure)?;
        if self.job.done()? {
            return Err(failure("task has already finished"));
        }
        if let Some(pending) = state.pending.take() {
            pending
                .answer
                .send(Some(message))
                .map_err(|_| failure("child question receiver closed"))?;
            return Ok("Answered the task agent's question.".into());
        }
        let guidance = format!("Parent guidance:\n{message}");
        if let Some(control) = &state.control {
            control.steer(guidance)?;
        } else {
            if state.guidance.len() >= 128 {
                return Err(failure("task guidance queue full"));
            }
            state.guidance.push(guidance);
        }
        Ok("Guidance queued for the task agent.".into())
    }

    pub fn extend(&self, turns: u32) -> Result<String> {
        let mut state = self.state.lock().map_err(failure)?;
        if !(1..=100).contains(&turns)
            || state
                .budget
                .checked_add(turns)
                .is_none_or(|budget| budget > u32::MAX / 3)
        {
            return Err(failure(
                "extension must add between 1 and 100 turns without overflowing the hard limit",
            ));
        }
        if self.job.done()? || self.job.cancellation.check().is_err() {
            return Err(failure("cannot extend a stopping or completed task"));
        }
        state.budget += turns;
        Ok(format!(
            "Task budget is now {} turns (hard limit {}). The deadline is unchanged.",
            state.budget,
            (state.budget * 3).div_ceil(2)
        ))
    }

    pub fn cycle(&self) -> Result<Option<String>> {
        let mut state = self.state.lock().map_err(failure)?;
        state.turns += 1;
        let limit = (state.budget * 3).div_ceil(2);
        if state.turns >= state.budget && state.notice_at != state.budget {
            state.notice_at = state.budget;
            return Ok(Some(format!(
                "You are near your turn budget. Settle or stop background jobs and produce your final report within the next {} turns.",
                limit - state.turns
            )));
        }
        Ok(None)
    }

    pub fn limit_reached(&self) -> Result<bool> {
        let state = self.state.lock().map_err(failure)?;
        Ok(state.turns >= (state.budget * 3).div_ceil(2))
    }

    pub fn workspace(&self, workspace: &str) -> Result<()> {
        self.state.lock().map_err(failure)?.workspace = Some(self.redactor.redact(workspace));
        Ok(())
    }

    pub fn supervision_wait(&self, requested: Duration) -> Result<Duration> {
        let state = self.state.lock().map_err(failure)?;
        if state.timeout.is_zero() {
            return Ok(requested);
        }
        let now = crate::agent::now()?;
        let remaining = state.deadline_at.map_or(state.timeout, |at| {
            Duration::from_millis(at.saturating_sub(now))
        });
        Ok(requested
            .min(remaining.saturating_sub((state.timeout / 5).min(Duration::from_secs(60)))))
    }

    pub fn progress(&self) -> Result<String> {
        let state = self.state.lock().map_err(failure)?;
        Ok(format!(
            "Task is {}.\n{}\nIncomplete transcript: {}\nFull log: {}",
            state.activity,
            state.transcript,
            self.record.display(),
            self.log.display()
        ))
    }

    pub async fn ask(&self, question: &str, cancellation: &Cancellation) -> Result<String> {
        message_length(question)?;
        cancellation.check()?;
        let question = Question {
            request_id: xal_services::credentials::new_id().map_err(failure)?,
            job_id: self.job.id.clone(),
            question: self.redactor.redact(question.trim()),
        };
        let (answer, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(failure)?;
            if state.pending.is_some() {
                return Err(failure("a parent question is already pending"));
            }
            state.pending = Some(Pending {
                question,
                delivered: false,
                corrected: false,
                answer,
                _activity: self.job.question(),
            });
            state.activity = "waiting for parent".into();
        }
        self.job.activity.notify_waiters();
        let result = tokio::select! { biased; () = cancellation.cancelled() => Err(Error::Cancelled), result = receive => result.map_err(failure) };
        let mut state = self.state.lock().map_err(failure)?;
        state.pending = None;
        state.activity = "running".into();
        match result? { Some(answer) => Ok(format!("Parent answered:\n{answer}")), None => Ok("Parent unavailable: the parent finished without answering. Continue independently where possible or report the blocker clearly.".into()) }
    }

    pub fn event(&self, event: AgentEvent) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        state.last_activity = crate::agent::now()?;
        match &event {
            AgentEvent::StateChanged {
                state: crate::agent::AgentState::Streaming,
            } => {
                state.provider_requests += 1;
                state.activity = "streaming".into();
            }
            AgentEvent::ToolStarted { tool, .. } => {
                state.tool_count += 1;
                state.activity = tool.clone();
            }
            _ => {}
        }
        let section = match &event {
            AgentEvent::AssistantMessage { text } => {
                state.last_report = self.redactor.redact(text);
                Some(format!("\n## Assistant\n\n{text}\n"))
            }
            AgentEvent::ToolFinished { tool, output, .. } => {
                Some(format!("\n## Tool: {tool}\n\n{output}\n"))
            }
            AgentEvent::UserMessage { text, .. } => Some(format!("\n## User\n\n{text}\n")),
            _ => None,
        };
        if let Some(section) = section {
            let section = self.redactor.redact(&section);
            state.transcript.push_str(&section);
            let start = state
                .transcript
                .ceil_char_boundary(state.transcript.len().saturating_sub(1024 * 1024));
            state.transcript.drain(..start);
        }
        let text = format!(
            "{}\n",
            self.redactor
                .redact_json(&serde_json::to_value(event).map_err(failure)?)
        );
        append_record(&mut state, &text)
    }

    pub fn snapshot(&self) -> Result<Value> {
        let state = self.state.lock().map_err(failure)?;
        let mut snapshot = self.job.snapshot()?;
        snapshot["runningAt"] = json!(state.running_at);
        snapshot["deadlineAt"] = json!(state.deadline_at);
        snapshot["completedTurns"] = json!(state.turns);
        snapshot["turnBudget"] = json!(state.budget);
        snapshot["turnLimit"] = json!((state.budget * 3).div_ceil(2));
        snapshot["activity"] = json!(state.activity);
        snapshot["lastActivityAt"] = json!(state.last_activity);
        snapshot["providerRequests"] = json!(state.provider_requests);
        snapshot["toolCount"] = json!(state.tool_count);
        Ok(snapshot)
    }

    fn settle_record(&self, report: &str, status: Status) -> Result<String> {
        let mut state = self.state.lock().map_err(failure)?;
        if let Some(pending) = state.pending.take()
            && pending.answer.send(None).is_err()
        {
            state.activity = "parent channel closed".into();
        }
        state.control = None;
        let mut report = self.redactor.redact(report);
        if status != Status::Completed && !state.last_report.trim().is_empty() {
            report.push_str(&format!("\n\nLast report:\n{}", state.last_report));
        }
        if status != Status::Completed && !state.transcript.is_empty() {
            let start = state
                .transcript
                .ceil_char_boundary(state.transcript.len().saturating_sub(12_000));
            report.push_str(&format!(
                "\n\nIncomplete transcript tail:\n{}",
                &state.transcript[start..]
            ));
        }
        let content = format!(
            "# Task agent {}\n\n- Status: {status:?}\n- Full log: {}{}\n\n## Assignment\n\n{}\n{}\n## Final report\n\n{report}\n\n## Transcript\n{}",
            self.job.id,
            self.log.display(),
            if state.capped { " (capped)" } else { "" },
            state.assignment,
            state
                .workspace
                .as_ref()
                .map_or_else(String::new, |w| format!("\n## Workspace\n\n{w}\n")),
            state.transcript
        );
        let record = state
            .record
            .take()
            .ok_or_else(|| failure("task record already closed"))?;
        let saved = record.sync_all().map_err(failure);
        drop(record);
        let logged = state
            .log
            .take()
            .map_or(Ok(()), |log| log.sync_all().map_err(failure));
        saved.and(logged)?;
        xal_services::storage::write_text(&self.record, &content).map_err(failure)?;
        Ok(format!(
            "{report}\nTask record: {}\nFull log: {}{}",
            self.record.display(),
            self.log.display(),
            if state.capped { " (capped)" } else { "" }
        ))
    }
}

pub struct Invocation {
    pub context: String,
    pub assignment: Assignment,
    pub parent: Session,
    pub options: Options,
    pub permissions: crate::permissions::Permissions,
    pub handle: Arc<Handle>,
}

pub type Factory = Arc<dyn Fn(Invocation) -> Result<String> + Send + Sync>;

pub struct Service {
    settings: AgentSettings,
    slots: Arc<Semaphore>,
    factory: Factory,
    entries: Mutex<BTreeMap<String, Arc<Handle>>>,
    redactor: Arc<Redactor>,
}

impl Service {
    pub fn new(settings: AgentSettings, factory: Factory, redactor: Arc<Redactor>) -> Arc<Self> {
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(usize::from(settings.max_concurrent))),
            settings,
            factory,
            entries: Mutex::default(),
            redactor,
        })
    }

    pub fn get(&self, owner: &str, id: &str) -> Result<Arc<Handle>> {
        self.entries
            .lock()
            .map_err(failure)?
            .get(&format!("{owner}/{id}"))
            .cloned()
            .ok_or_else(|| failure("task is not owned by this session"))
    }

    pub fn questions(&self, owner: &str) -> Result<Vec<Question>> {
        let mut questions = Vec::new();
        for task in self
            .entries
            .lock()
            .map_err(failure)?
            .values()
            .filter(|h| h.owner == owner)
        {
            let mut state = task.state.lock().map_err(failure)?;
            if let Some(pending) = &mut state.pending
                && !pending.delivered
            {
                questions.push(pending.question.clone());
            }
        }
        Ok(questions)
    }

    pub fn instructions(&self, owner: &str) -> Result<String> {
        let mut messages = Vec::new();
        for task in self
            .entries
            .lock()
            .map_err(failure)?
            .values()
            .filter(|h| h.owner == owner)
        {
            let state = task.state.lock().map_err(failure)?;
            if let Some(pending) = &state.pending {
                messages.push(format!("{}: {}{}", pending.question.job_id, pending.question.question,
                    if pending.corrected { "\nThis question remains unanswered. Answer before finishing, or the child will be told the parent is unavailable." } else { "" }));
            }
        }
        Ok(if messages.is_empty() {
            String::new()
        } else {
            format!(
                "Task agents need answers. Use job_send with each job ID to answer.\n{}",
                messages.join("\n")
            )
        })
    }

    pub fn acknowledge_questions(&self, owner: &str, questions: &[Question]) -> Result<()> {
        for question in questions {
            let task = self.get(owner, &question.job_id)?;
            let mut state = task.state.lock().map_err(failure)?;
            if let Some(pending) = &mut state.pending
                && pending.question.request_id == question.request_id
            {
                pending.delivered = true;
            }
        }
        Ok(())
    }

    pub fn unanswered(&self, owner: &str) -> Result<bool> {
        let mut correction = false;
        for task in self
            .entries
            .lock()
            .map_err(failure)?
            .values()
            .filter(|h| h.owner == owner)
        {
            let mut state = task.state.lock().map_err(failure)?;
            if let Some(pending) = &mut state.pending
                && pending.delivered
            {
                if pending.corrected {
                    if let Some(pending) = state.pending.take() {
                        let _ = pending.answer.send(None);
                    }
                } else {
                    pending.corrected = true;
                    correction = true;
                }
            }
        }
        Ok(correction)
    }

    pub fn pending(&self, owner: &str) -> Result<bool> {
        for task in self
            .entries
            .lock()
            .map_err(failure)?
            .values()
            .filter(|h| h.owner == owner)
        {
            if task.state.lock().map_err(failure)?.pending.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn dispose(&self, owner: &str) -> Result<()> {
        self.entries
            .lock()
            .map_err(failure)?
            .retain(|_, task| task.owner != owner);
        Ok(())
    }

    pub fn spawn(
        &self,
        context: String,
        assignment: Assignment,
        parent: Session,
        options: Options,
        permissions: crate::permissions::Permissions,
    ) -> Result<String> {
        {
            let mut entries = self.entries.lock().map_err(failure)?;
            let mut expired = Vec::new();
            for (id, task) in entries.iter() {
                if !task
                    .jobs
                    .upgrade()
                    .map_or(Ok(false), |jobs| jobs.owns(&task.job))?
                {
                    expired.push(id.clone());
                }
            }
            for id in expired {
                entries.remove(&id);
            }
        }
        let directory = parent
            .jobs
            .directory
            .as_ref()
            .ok_or_else(|| failure("task record storage is not configured"))?;
        crate::agent::storage::secure_directory(directory)?;
        let record = directory.join(format!(
            "agent-{}.md",
            xal_services::credentials::new_id().map_err(failure)?
        ));
        let mut file = xal_services::storage::create_secure(&record).map_err(failure)?;
        let log = record.with_extension("log");
        let log_file = xal_services::storage::create_secure(&log).map_err(failure)?;
        let assignment_text = self.redactor.redact(&format!(
            "# Context\n{context}\n\n# Assignment\n{}",
            assignment.task
        ));
        file.write_all(format!("# Task agent\n\n- Status: queued\n- Full log: {}\n\n## Assignment\n\n{assignment_text}\n", log.display()).as_bytes()).map_err(failure)?;
        file.sync_all().map_err(failure)?;
        let job = parent.jobs.create_named(
            Kind::Agent {
                task: self.redactor.redact(&assignment.task),
            },
            true,
            assignment.name.as_deref(),
        )?;
        let handle = Arc::new(Handle {
            job: job.clone(),
            owner: parent.id.clone(),
            jobs: Arc::downgrade(&parent.jobs),
            record,
            log,
            state: Mutex::new(State {
                control: None,
                guidance: Vec::new(),
                pending: None,
                running_at: None,
                deadline_at: None,
                turns: 0,
                budget: u32::from(self.settings.max_turns),
                notice_at: 0,
                provider_requests: 0,
                tool_count: 0,
                activity: "queued".into(),
                last_activity: crate::agent::now()?,
                record: Some(file),
                log: Some(log_file),
                assignment: assignment_text,
                workspace: None,
                transcript: String::new(),
                last_report: String::new(),
                timeout: Duration::from_secs(u64::from(self.settings.timeout_minutes) * 60),
                bytes: 0,
                capped: false,
            }),
            redactor: self.redactor.clone(),
        });
        self.entries
            .lock()
            .map_err(failure)?
            .insert(format!("{}/{}", parent.id, job.id), handle.clone());
        job.state.lock().map_err(failure)?.detail = "queued".into();
        let jobs = parent.jobs.clone();
        let invocation = Invocation {
            context,
            assignment,
            parent,
            options,
            permissions,
            handle,
        };
        let slots = self.slots.clone();
        let factory = self.factory.clone();
        let timeout = Duration::from_secs(u64::from(self.settings.timeout_minutes) * 60);
        jobs.track(tokio::spawn(async move {
            supervise(invocation, slots, factory, timeout).await
        }))?;
        Ok(job.id.clone())
    }
}

async fn supervise(
    invocation: Invocation,
    slots: Arc<Semaphore>,
    factory: Factory,
    timeout: Duration,
) -> Result<()> {
    let handle = invocation.handle.clone();
    let job = handle.job.clone();
    let mut timed_out = false;
    let mut permit = None;
    let result = async {
        permit = Some(tokio::select! { biased; () = job.cancellation.cancelled() => return Err(Error::Cancelled), permit = slots.acquire_owned() => permit.map_err(failure)? });
        let now = crate::agent::now()?;
        {
            let mut state = handle.state.lock().map_err(failure)?;
            state.running_at = Some(now); state.activity = "starting".into();
            state.deadline_at = (!timeout.is_zero()).then_some(now + u64::try_from(timeout.as_millis()).map_err(failure)?);
        }
        job.state.lock().map_err(failure)?.detail = "running".into();
        let mut run = tokio::task::spawn_blocking(move || factory(invocation));

        if timeout.is_zero() { run.await.map_err(failure)? } else {
            tokio::select! {
                result = &mut run => result.map_err(failure)?,
                () = tokio::time::sleep(timeout) => { timed_out = true; job.cancellation.cancel(); run.await.map_err(failure)? },
            }
        }
    }.await;
    let (status, report) = match result {
        Err(error) if error != Error::Cancelled => {
            (Status::Failed, format!("Task failed: {error}"))
        }
        _ if timed_out => (
            Status::TimedOut,
            "Task reached its deadline; child resources have stopped.".into(),
        ),
        Err(Error::Cancelled) => (
            Status::Interrupted,
            "Task interrupted; child resources have stopped.".into(),
        ),
        Ok(report) => (Status::Completed, report),
        Err(error) => (Status::Failed, error.to_string()),
    };
    let recorded = handle.settle_record(&report, status);
    let (status, report) = match recorded {
        Ok(report) => (status, report),
        Err(error) => (
            Status::Failed,
            format!("{report}\nTask record unavailable: {error}"),
        ),
    };
    job.append(&report)?;
    let settled = job.finish(
        status,
        match status {
            Status::Running => return Err(failure("invalid terminal task state")),
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Interrupted => "interrupted",
            Status::TimedOut => "timed out",
        }
        .into(),
    );
    drop(permit);
    settled
}

fn append_record(state: &mut State, text: &str) -> Result<()> {
    let available = (64 * 1024 * 1024usize).saturating_sub(state.bytes);
    let text_end = text.floor_char_boundary(available.min(text.len()));
    state
        .log
        .as_mut()
        .ok_or_else(|| failure("task log is closed"))?
        .write_all(&text.as_bytes()[..text_end])
        .map_err(failure)?;
    state.bytes += text_end;
    state.capped |= text_end != text.len();
    Ok(())
}
fn message_length(message: &str) -> Result<()> {
    if message.trim().is_empty() || message.encode_utf16().count() > 20_000 {
        return Err(failure("agent message must contain 1–20000 characters"));
    }
    Ok(())
}
fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
