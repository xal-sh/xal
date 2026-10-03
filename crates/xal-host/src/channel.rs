use tokio::sync::mpsc;

use crate::{Cancellation, Error, Result};

pub struct Sender<T> {
    inner: mpsc::Sender<T>,
    cancellation: Cancellation,
}

pub struct Receiver<T> {
    inner: mpsc::Receiver<T>,
    cancellation: Cancellation,
}

pub fn channel<T>(capacity: usize, cancellation: Cancellation) -> Result<(Sender<T>, Receiver<T>)> {
    if capacity == 0 {
        return Err(Error::Failed("queue capacity must be positive".into()));
    }
    let (sender, receiver) = mpsc::channel(capacity);
    Ok((
        Sender {
            inner: sender,
            cancellation: cancellation.clone(),
        },
        Receiver {
            inner: receiver,
            cancellation,
        },
    ))
}

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            cancellation: self.cancellation.clone(),
        }
    }
}

impl<T> Sender<T> {
    pub async fn send(&self, value: T) -> Result<()> {
        self.cancellation.check()?;
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(Error::Cancelled),
            result = self.inner.send(value) => result.map_err(|_| Error::Failed("queue receiver closed".into())),
        }
    }

    pub fn try_send(&self, value: T) -> Result<()> {
        self.cancellation.check()?;
        self.inner.try_send(value).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => Error::Failed("event queue full".into()),
            mpsc::error::TrySendError::Closed(_) => {
                Error::Failed("event subscription closed".into())
            }
        })
    }
}

impl<T> Receiver<T> {
    pub fn close(&mut self) {
        self.inner.close();
    }

    pub fn try_recv(&mut self) -> Result<Option<T>> {
        self.cancellation.check()?;
        match self.inner.try_recv() {
            Ok(value) => Ok(Some(value)),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected) => {
                Ok(None)
            }
        }
    }

    pub async fn recv(&mut self) -> Result<Option<T>> {
        self.cancellation.check()?;
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => Err(Error::Cancelled),
            value = self.inner.recv() => Ok(value),
        }
    }
}
