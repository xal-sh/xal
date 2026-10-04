use std::collections::VecDeque;
use std::sync::{Arc, Mutex, atomic::Ordering};

use tokio::sync::Notify;

use super::Input;
use crate::{Cancellation, Error, Result};

struct State {
    queue: VecDeque<Input>,
    active: Option<Cancellation>,
    turn: Option<Cancellation>,
    steering: bool,
    accepting: bool,
    pause: bool,
    jobs: Arc<crate::jobs::Jobs>,
}

#[derive(Clone)]
pub struct Control {
    state: Arc<Mutex<State>>,
    pub(super) changed: Arc<Notify>,
    cancellation: Cancellation,
}

impl Control {
    pub(super) fn new(cancellation: Cancellation, jobs: Arc<crate::jobs::Jobs>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                queue: VecDeque::new(),
                active: None,
                turn: None,
                steering: false,
                accepting: true,
                pause: false,
                jobs,
            })),
            changed: Arc::new(Notify::new()),
            cancellation,
        }
    }

    pub fn queue(&self, input: Input) -> Result<()> {
        self.push(input, false)
    }

    pub fn steer(&self, text: String) -> Result<()> {
        self.push(
            Input {
                text,
                images: Vec::new(),
            },
            true,
        )
    }

    fn push(&self, input: Input, steer: bool) -> Result<()> {
        self.cancellation.check()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        if !state.accepting {
            return Err(Error::Failed("session is not accepting input".into()));
        }
        if state.queue.len() >= 128 {
            return Err(Error::Failed("input queue full".into()));
        }
        state.queue.push_back(input);
        state.jobs.input_pending.store(true, Ordering::Release);
        if steer {
            state.steering = true;
            if let Some(active) = &state.active {
                active.cancel();
            }
        }
        self.changed.notify_one();
        state.jobs.activity.notify_waiters();
        Ok(())
    }

    pub fn promote(&self, id: &str) -> Result<()> {
        self.jobs()?.get(id)?.promote()
    }

    pub fn jobs(&self) -> Result<Arc<crate::jobs::Jobs>> {
        Ok(self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?
            .jobs
            .clone())
    }

    pub(super) fn reset(&self, jobs: Arc<crate::jobs::Jobs>) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        jobs.input_pending
            .store(state.pause || !state.queue.is_empty(), Ordering::Release);
        state.jobs = jobs;
        Ok(())
    }

    pub fn pause(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        state.pause = true;
        state.jobs.input_pending.store(true, Ordering::Release);
        self.changed.notify_waiters();
        state.jobs.activity.notify_waiters();
        Ok(())
    }

    pub(super) fn boundary(&self) -> Result<()> {
        if self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?
            .pause
        {
            return Err(Error::Paused);
        }
        Ok(())
    }

    pub fn interrupt(&self) {
        match self.state.lock() {
            Ok(state) => {
                if let Some(turn) = &state.turn {
                    turn.cancel();
                }
            }
            Err(_) => self.cancellation.cancel(),
        }
    }

    pub(super) fn begin(&self) -> Result<Cancellation> {
        self.cancellation.check()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        let turn = self.cancellation.child();
        state.turn = Some(turn.clone());
        state.pause = false;
        state
            .jobs
            .input_pending
            .store(!state.queue.is_empty(), Ordering::Release);
        state.accepting = true;
        Ok(turn)
    }

    pub(super) fn lifetime(&self) -> Cancellation {
        self.cancellation.clone()
    }

    pub(super) fn active(&self, cancellation: Cancellation) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        if state.steering {
            cancellation.cancel();
        }
        state.active = Some(cancellation);
        Ok(())
    }

    pub(super) fn pending(&self) -> Result<Vec<Input>> {
        Ok(self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?
            .queue
            .iter()
            .cloned()
            .collect())
    }

    pub(super) fn drain(&self) -> Result<Vec<Input>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        state.active = None;
        state.steering = false;
        state
            .jobs
            .input_pending
            .store(state.pause, Ordering::Release);
        Ok(state.queue.drain(..).collect())
    }

    pub(super) fn steered(&self) -> Result<bool> {
        self.cancellation.check()?;
        Ok(self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?
            .steering)
    }

    pub(super) fn finish_if_empty(&self) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?;
        if !state.queue.is_empty() {
            return Ok(false);
        }
        state.accepting = false;
        Ok(true)
    }

    pub(super) fn close(&self) -> Result<Vec<Input>> {
        self.state
            .lock()
            .map_err(|_| Error::Failed("input queue poisoned".into()))?
            .accepting = false;
        self.drain()
    }
}
