use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use crate::agent::AgentEvent;
use crate::{Cancellation, Error, Result};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<Choice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    pub question_id: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Answers {
    Answered { answers: Vec<Answer> },
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub enum Approval {
    Denied,
    Once,
    Session { pattern: String },
    Always { pattern: String },
}

struct Pending {
    id: String,
    questions: Vec<Question>,
    answer: oneshot::Sender<Answers>,
}

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    approval: Option<(String, oneshot::Sender<Approval>)>,
    events: VecDeque<AgentEvent>,
    updates: VecDeque<(crate::workflows::Update, oneshot::Sender<Result<()>>)>,
}

#[derive(Default)]
pub struct Interactions {
    state: Mutex<State>,
    gate: tokio::sync::Mutex<()>,
    pub changed: Notify,
}

impl Interactions {
    pub async fn update(
        &self,
        update: crate::workflows::Update,
        cancellation: &Cancellation,
    ) -> Result<()> {
        cancellation.check()?;
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(failure)?;
            if state.updates.len() >= 128 {
                return Err(failure("session update queue full"));
            }
            state.updates.push_back((update, send));
        }
        self.changed.notify_one();
        tokio::select! { biased; () = cancellation.cancelled() => Err(Error::Cancelled), result = receive => result.map_err(failure)? }
    }

    pub(crate) fn updates(
        &self,
    ) -> Result<Vec<(crate::workflows::Update, oneshot::Sender<Result<()>>)>> {
        Ok(self
            .state
            .lock()
            .map_err(failure)?
            .updates
            .drain(..)
            .collect())
    }

    pub fn emit(&self, event: AgentEvent) -> Result<()> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.events.len() >= 128 {
            return Err(failure("session event queue full"));
        }
        state.events.push_back(event);
        self.changed.notify_one();
        Ok(())
    }

    pub fn drain(&self) -> Result<Vec<AgentEvent>> {
        Ok(self
            .state
            .lock()
            .map_err(failure)?
            .events
            .drain(..)
            .collect())
    }

    pub fn pending(&self) -> Result<bool> {
        let state = self.state.lock().map_err(failure)?;
        Ok(state.pending.is_some() || state.approval.is_some())
    }

    pub fn answer(&self, id: &str, answers: Answers) -> Result<bool> {
        let mut state = self.state.lock().map_err(failure)?;
        let Some(pending) = &state.pending else {
            return Ok(false);
        };
        if pending.id != id {
            return Ok(false);
        }
        let answers = match answers {
            Answers::Rejected => Answers::Rejected,
            Answers::Answered { answers } => {
                let mut normalized = Vec::new();
                if answers.len() != pending.questions.len() {
                    return Ok(false);
                }
                for question in &pending.questions {
                    let values = answers
                        .iter()
                        .filter(|a| a.question_id == question.id)
                        .collect::<Vec<_>>();
                    if values.len() != 1 || values[0].value.trim().is_empty() {
                        return Ok(false);
                    }
                    normalized.push(Answer {
                        question_id: question.id.clone(),
                        value: values[0].value.trim().into(),
                    });
                }
                Answers::Answered {
                    answers: normalized,
                }
            }
        };
        let pending = state
            .pending
            .take()
            .ok_or_else(|| failure("question disappeared"))?;
        pending
            .answer
            .send(answers)
            .map_err(|_| failure("question receiver closed"))?;
        Ok(true)
    }

    pub async fn request(
        &self,
        call_id: String,
        questions: Vec<Question>,
        cancellation: &Cancellation,
    ) -> Result<Answers> {
        cancellation.check()?;
        let _guard = tokio::select! { biased; () = cancellation.cancelled() => return Err(Error::Cancelled), guard = self.gate.lock() => guard };
        let prepared =
            xal_services::tool_runtime::request_input_prepare(&json!({"questions":questions}))
                .map_err(failure)?;
        let questions: Vec<Question> =
            serde_json::from_value(prepared["questions"].clone()).map_err(failure)?;
        let id = xal_services::credentials::new_id().map_err(failure)?;
        let (answer, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(failure)?;
            if state.pending.is_some() || state.approval.is_some() {
                return Err(failure("another interaction is pending"));
            }
            state.pending = Some(Pending {
                id: id.clone(),
                questions: questions.clone(),
                answer,
            });
        }
        let result = async {
            self.emit(AgentEvent::ElicitationRequested {
                request_id: id,
                call_id: call_id.clone(),
                questions,
            })?;
            tokio::select! {
                biased;
                () = cancellation.cancelled() => Err(Error::Cancelled),
                result = receive => result.map_err(failure),
            }
        }
        .await;
        self.state.lock().map_err(failure)?.pending = None;
        self.emit(AgentEvent::ElicitationResolved { call_id })?;
        result
    }

    pub fn approve(&self, call_id: &str, approved: Approval) -> Result<bool> {
        let mut state = self.state.lock().map_err(failure)?;
        if state.approval.as_ref().is_none_or(|(id, _)| id != call_id) {
            return Ok(false);
        }
        let (_, answer) = state
            .approval
            .take()
            .ok_or_else(|| failure("approval disappeared"))?;
        answer
            .send(approved)
            .map_err(|_| failure("approval receiver closed"))?;
        Ok(true)
    }

    pub async fn approval(
        &self,
        event: AgentEvent,
        cancellation: &Cancellation,
    ) -> Result<Approval> {
        cancellation.check()?;
        let _guard = tokio::select! { biased; () = cancellation.cancelled() => return Err(Error::Cancelled), guard = self.gate.lock() => guard };
        let AgentEvent::ApprovalRequested { call_id, .. } = &event else {
            return Err(failure("invalid approval event"));
        };
        let (answer, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(failure)?;
            if state.pending.is_some() || state.approval.is_some() {
                return Err(failure("another interaction is pending"));
            }
            state.approval = Some((call_id.clone(), answer));
        }
        let result = async {
            self.emit(event)?;
            tokio::select! { biased; () = cancellation.cancelled() => Err(Error::Cancelled), result = receive => result.map_err(failure) }
        }.await;
        self.state.lock().map_err(failure)?.approval = None;
        result
    }
}

#[derive(Default)]
pub struct Registry(Mutex<BTreeMap<String, Arc<Interactions>>>);
impl Registry {
    pub fn get(&self, id: &str) -> Result<Arc<Interactions>> {
        Ok(self
            .0
            .lock()
            .map_err(failure)?
            .entry(id.into())
            .or_default()
            .clone())
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        self.0.lock().map_err(failure)?.remove(id);
        Ok(())
    }
}

pub fn questions(value: &Value) -> Result<Vec<Question>> {
    let prepared = xal_services::tool_runtime::request_input_prepare(value).map_err(failure)?;
    serde_json::from_value(prepared["questions"].clone()).map_err(failure)
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
