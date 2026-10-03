use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use super::Input;
use crate::{Cancellation, Error, Result};

struct State {
    queue: VecDeque<Input>,
    active: Option<Cancellation>,
    steering: bool,
    accepting: bool,
}

#[derive(Clone)]
pub struct Control {
    state: Arc<Mutex<State>>,
    pub(super) changed: Arc<Notify>,
    cancellation: Cancellation,
}

impl Control {
    pub(super) fn new(cancellation: Cancellation) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                queue: VecDeque::new(),
                active: None,
                steering: false,
                accepting: true,
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
        if steer {
            state.steering = true;
            if let Some(active) = &state.active {
                active.cancel();
            }
        }
        self.changed.notify_one();
        Ok(())
    }

    pub fn interrupt(&self) {
        self.cancellation.cancel();
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
