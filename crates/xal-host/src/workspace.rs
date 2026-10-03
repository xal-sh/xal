use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::{Context, Error, Host, Result, Session, SessionKind};

pub(crate) type Change = Arc<Mutex<Option<PathBuf>>>;

impl Context {
    pub fn change_workspace(&self, path: PathBuf) -> Result<()> {
        if self.session.read_only || self.session.kind == SessionKind::Task {
            return Err(Error::Denied(
                "workspace switching is unavailable in this session".into(),
            ));
        }
        let pending = self.workspace.as_ref().ok_or_else(|| {
            Error::Denied("workspace switching requires an authorized modifying tool".into())
        })?;
        let path = path
            .canonicalize()
            .map_err(|error| Error::Failed(format!("cannot resolve new workspace: {error}")))?;
        if !path.is_dir() {
            return Err(Error::Failed("new workspace is not a directory".into()));
        }
        let mut pending = pending
            .lock()
            .map_err(|_| Error::Failed("workspace change lock poisoned".into()))?;
        if pending.is_some() {
            return Err(Error::Failed(
                "a workspace change is already pending".into(),
            ));
        }
        *pending = Some(path);
        Ok(())
    }
}

impl Host {
    pub fn effective_session(&self, session: &Session) -> Result<Session> {
        let workspaces = self
            .workspaces
            .lock()
            .map_err(|_| Error::Failed("workspace state lock poisoned".into()))?;
        let mut session = session.clone();
        if let Some(cwd) = workspaces.get(&session.id) {
            session.cwd = cwd.clone();
        }
        Ok(session)
    }

    pub(crate) async fn apply_workspace(&self, session: &Session, pending: Change) -> Result<()> {
        let path = pending
            .lock()
            .map_err(|_| Error::Failed("workspace change lock poisoned".into()))?
            .take();
        let Some(path) = path else {
            return Ok(());
        };
        let cleanup = self.dispose_resources(session).await;
        self.workspaces
            .lock()
            .map_err(|_| Error::Failed("workspace state lock poisoned".into()))?
            .insert(session.id.clone(), path);
        if cleanup.is_err() {
            session.cancellation.cancel();
        }
        cleanup
    }
}
