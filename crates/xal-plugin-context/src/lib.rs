mod instructions;
mod memory;
mod prompt_commands;
mod review;
mod skills;

pub use instructions::Instructions;
pub use memory::Memory;
pub use prompt_commands::PromptCommands;
pub use review::CodeReview;
pub use skills::{Skills, SkillsService};

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, RwLock,
    atomic::{AtomicBool, Ordering},
};

use xal_host::{Cancellation, Error, Result, Session};

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn boundary(error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::Interrupted {
        return Error::Cancelled;
    }
    failure(error)
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn blocking<T: Send + 'static>(
    cancellation: &Cancellation,
    operation: impl FnOnce(&AtomicBool) -> io::Result<T> + Send + 'static,
) -> Result<T> {
    cancellation.check()?;
    let guard = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    let flag = guard.0.clone();
    let mut task = tokio::task::spawn_blocking(move || operation(&flag));
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            guard.0.store(true, Ordering::Relaxed);
            match task.await.map_err(failure)? {
                Ok(_) => Err(Error::Cancelled),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => Err(Error::Cancelled),
                Err(error) => Err(boundary(error)),
            }
        }
        result = &mut task => result.map_err(failure)?.map_err(boundary),
    }
}

struct Cache<T> {
    values: RwLock<BTreeMap<PathBuf, Arc<T>>>,
    sessions: RwLock<BTreeMap<String, PathBuf>>,
}
impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self {
            values: RwLock::new(BTreeMap::new()),
            sessions: RwLock::new(BTreeMap::new()),
        }
    }
}
impl<T> Cache<T> {
    fn current(&self, session: &Session) -> Result<bool> {
        Ok(self
            .sessions
            .read()
            .map_err(|_| failure("context cache lock failed"))?
            .get(&session.id)
            == Some(&session.cwd))
    }
    fn track(&self, session: &Session) -> Result<()> {
        self.sessions
            .write()
            .map_err(|_| failure("context cache lock failed"))?
            .insert(session.id.clone(), session.cwd.clone());
        Ok(())
    }
    fn forget(&self, session: &Session) -> Result<()> {
        self.sessions
            .write()
            .map_err(|_| failure("context cache lock failed"))?
            .remove(&session.id);
        Ok(())
    }
    fn get(&self, cwd: &Path) -> Result<Option<Arc<T>>> {
        Ok(self
            .values
            .read()
            .map_err(|_| failure("context cache lock failed"))?
            .get(cwd)
            .cloned())
    }
    fn require(&self, cwd: &Path) -> Result<Arc<T>> {
        self.get(cwd)?.ok_or_else(|| {
            failure(format!(
                "context has not been prepared for {}",
                cwd.display()
            ))
        })
    }
    fn insert(&self, cwd: PathBuf, value: T) -> Result<Arc<T>> {
        let value = Arc::new(value);
        self.values
            .write()
            .map_err(|_| failure("context cache lock failed"))?
            .insert(cwd, value.clone());
        Ok(value)
    }
}
