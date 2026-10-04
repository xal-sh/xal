use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use xal_services::git::{
    ApplySnapshotRequest, CaptureRequest, GitSnapshot, GitlinksRequest, Repository, TreePairRequest,
};

use crate::{Error, JsonObject, Result};

#[derive(Clone, Copy)]
pub enum Scope {
    Path(&'static str),
    Workspace,
    Delegated,
}

#[derive(Clone)]
struct Checkpoint {
    id: String,
    position: usize,
    unavailable: Option<String>,
}

#[derive(Clone)]
struct Redo {
    checkpoint: Checkpoint,
    snapshots: Vec<GitSnapshot>,
}

#[derive(Clone, Default)]
pub struct History {
    workspace: Option<PathBuf>,
    snapshots: Vec<GitSnapshot>,
    checkpoints: Vec<Checkpoint>,
    redos: Vec<Redo>,
    busy: bool,
    epoch: u64,
    baseline: Option<(String, Vec<u8>)>,
}

pub type Shared = Arc<Mutex<History>>;

pub struct Capture {
    history: Shared,
    repository: Repository,
    request: CaptureRequest,
    tree: String,
    head: String,
    index: Vec<u8>,
    epoch: u64,
    finished: bool,
}

impl History {
    pub fn seed(&mut self, cwd: &Path, ids: impl IntoIterator<Item = String>) {
        self.workspace = Some(cwd.into());
        self.snapshots.clear();
        self.baseline = None;
        self.redos.clear();
        self.checkpoints = ids
            .into_iter()
            .map(|id| Checkpoint {
                id,
                position: 0,
                unavailable: Some("code before this process resumed was not captured".into()),
            })
            .collect();
    }

    pub fn checkpoint(
        &mut self,
        cwd: &Path,
        id: String,
        persist: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let mut next = self.clone();
        next.mark(cwd, id)?;
        persist()?;
        *self = next;
        Ok(())
    }

    pub fn mark(&mut self, cwd: &Path, id: String) -> Result<()> {
        if self.busy {
            return Err(failure(
                "cannot checkpoint while a modifying tool is running",
            ));
        }
        self.workspace(cwd);
        self.redos.clear();
        self.checkpoints.push(Checkpoint {
            id,
            position: self.snapshots.len(),
            unavailable: None,
        });
        Ok(())
    }

    fn workspace(&mut self, cwd: &Path) {
        if self.workspace.as_deref().is_some_and(|path| path != cwd) {
            self.invalidate("workspace changed; previous code history cannot be applied here");
        }
        self.workspace = Some(cwd.into());
    }

    pub fn invalidate(&mut self, reason: &str) {
        self.epoch = self.epoch.wrapping_add(1);
        for checkpoint in &mut self.checkpoints {
            checkpoint.unavailable = Some(reason.into());
        }
        for redo in &mut self.redos {
            redo.checkpoint.unavailable = Some(reason.into());
        }
    }

    pub fn preview(&self, id: &str) -> Result<Vec<String>> {
        if self.busy {
            return Err(failure("undo is unavailable while tools are running"));
        }
        let checkpoint = self
            .checkpoints
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| failure("code checkpoint unavailable"))?;
        if let Some(reason) = &checkpoint.unavailable {
            return Err(failure(reason));
        }
        Ok(paths(&self.snapshots[checkpoint.position..]))
    }

    pub fn begin(
        history: &Shared,
        cwd: &Path,
        name: &str,
        scope: Option<Scope>,
        args: &JsonObject,
        background: bool,
    ) -> Result<Option<Capture>> {
        let mut state = history.lock().map_err(failure)?;
        if state.checkpoints.is_empty() {
            return Ok(None);
        }
        state.workspace(cwd);
        if matches!(scope, Some(Scope::Delegated)) {
            return Ok(None);
        }
        if background || args.get("background").and_then(serde_json::Value::as_bool) == Some(true) {
            state.invalidate("background changes cannot be captured, so full undo is unavailable");
            return Ok(None);
        }
        let Some(scope) = scope else {
            state.invalidate(
                "a modifying tool without workspace snapshots ran; full undo is unavailable",
            );
            return Ok(None);
        };
        if state.busy {
            return Err(failure(
                "Git snapshot failed; modifying tool was not run: another capture is active",
            ));
        }
        let repository = Repository::new(cwd.to_string_lossy().into_owned()).map_err(failure)?;
        match repository.root() {
            Ok(_) => {}
            Err(error) => {
                state.invalidate(&format!("code undo requires a Git repository: {error}"));
                return Ok(None);
            }
        };
        let forced = if !matches!(scope, Scope::Path(_)) {
            Vec::new()
        } else {
            let Scope::Path(field) = scope else {
                return Err(failure("invalid path snapshot scope"));
            };
            let path = args
                .get(field)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| failure("snapshot target missing"))?;
            let target = crate::permissions::resolve_path(cwd, path)?;
            let workspace = cwd.canonicalize().map_err(failure)?;
            if !target.starts_with(&workspace) {
                state.invalidate(
                    "tool targeted a path outside the workspace; full undo is unavailable",
                );
                return Ok(None);
            }
            vec![
                target
                    .strip_prefix(&workspace)
                    .map_err(failure)?
                    .to_string_lossy()
                    .replace('\\', "/"),
            ]
        };
        let request = CaptureRequest {
            forced,
            full: matches!(scope, Scope::Workspace),
        };
        let capture = (|| {
            let head = repository.head_state().map_err(failure)?;
            let index = repository.index_state(&[]).map_err(failure)?;
            if state
                .baseline
                .as_ref()
                .is_some_and(|(previous_head, previous_index)| {
                    previous_head != &head || previous_index != &index
                })
            {
                state.invalidate(
                    "Git HEAD or index changed outside captured tools; full undo is unavailable",
                );
            }
            state.baseline = Some((head.clone(), index.clone()));
            let tree = repository.capture(&request).map_err(failure)?;
            Ok(Capture {
                history: history.clone(),
                repository,
                request,
                tree,
                head,
                index,
                epoch: state.epoch,
                finished: false,
            })
        })()
        .map_err(|error: Error| {
            failure(format!("Git snapshot failed; {name} was not run: {error}"))
        })?;
        state.busy = true;
        Ok(Some(capture))
    }

    pub fn rewind(
        &mut self,
        id: &str,
        steps: usize,
        persist: impl FnOnce(usize) -> Result<()>,
    ) -> Result<()> {
        self.preview(id)?;
        let position = self
            .checkpoints
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| failure("checkpoint disappeared"))?;
        if self.checkpoints.len() - position != steps {
            return Err(failure("conversation and code checkpoints disagree"));
        }
        let start = self.checkpoints[position].position;
        let snapshots = self.snapshots[start..].to_vec();
        let repository = Repository::new(
            self.workspace
                .as_ref()
                .ok_or_else(|| failure("workspace unavailable"))?
                .to_string_lossy()
                .into_owned(),
        )
        .map_err(failure)?;
        self.verify(&repository)?;
        transact(&repository, &snapshots, true, || {
            persist(paths(&snapshots).len())
        })?;
        let checkpoints = self.checkpoints.split_off(position);
        let mut redos = Vec::new();
        for (index, checkpoint) in checkpoints.iter().enumerate() {
            let end = checkpoints
                .get(index + 1)
                .map_or(self.snapshots.len(), |p| p.position);
            redos.push(Redo {
                checkpoint: checkpoint.clone(),
                snapshots: self.snapshots[checkpoint.position..end].to_vec(),
            });
        }
        self.snapshots.truncate(start);
        self.redos.extend(redos.into_iter().rev());
        Ok(())
    }

    fn verify(&self, repository: &Repository) -> Result<()> {
        if let Some((head, index)) = &self.baseline
            && (repository.head_state().map_err(failure)? != *head
                || repository.index_state(&[]).map_err(failure)? != *index)
        {
            return Err(failure(
                "Git HEAD or index changed; undo/redo was not applied",
            ));
        }
        Ok(())
    }

    pub fn redo(&mut self, id: &str, persist: impl FnOnce(usize) -> Result<()>) -> Result<()> {
        if self.busy {
            return Err(failure("redo is unavailable while tools are running"));
        }
        let redo = self
            .redos
            .last()
            .ok_or_else(|| failure("code redo unavailable"))?;
        if redo.checkpoint.id != id || redo.checkpoint.position != self.snapshots.len() {
            return Err(failure("code redo no longer matches this conversation"));
        }
        if let Some(reason) = &redo.checkpoint.unavailable {
            return Err(failure(reason));
        }
        let repository = Repository::new(
            self.workspace
                .as_ref()
                .ok_or_else(|| failure("workspace unavailable"))?
                .to_string_lossy()
                .into_owned(),
        )
        .map_err(failure)?;
        self.verify(&repository)?;
        transact(&repository, &redo.snapshots, false, || {
            persist(paths(&redo.snapshots).len())
        })?;
        let redo = self
            .redos
            .pop()
            .ok_or_else(|| failure("code redo disappeared"))?;
        self.checkpoints.push(redo.checkpoint);
        self.snapshots.extend(redo.snapshots);
        Ok(())
    }
}

impl Capture {
    pub fn finish(mut self) -> Result<()> {
        let result = self.finish_inner();
        let mut history = self.history.lock().map_err(failure)?;
        history.busy = false;
        if result.is_err() {
            history.invalidate("tool changes could not be captured; full undo is unavailable");
        }
        self.finished = true;
        result.map_err(|error| {
            failure(format!(
                "tool completed, but its undo snapshot could not be recorded: {error}"
            ))
        })
    }

    fn finish_inner(&self) -> Result<()> {
        let mut history = self.history.lock().map_err(failure)?;
        if history.epoch != self.epoch {
            return Ok(());
        }
        if self.repository.head_state().map_err(failure)? != self.head
            || self.repository.index_state(&[]).map_err(failure)? != self.index
        {
            history
                .invalidate("Git HEAD or index changed during the tool; full undo is unavailable");
            return Ok(());
        }
        let after = self.repository.capture(&self.request).map_err(failure)?;
        let changed = self
            .repository
            .changed_paths(&TreePairRequest {
                before: self.tree.clone(),
                after: after.clone(),
            })
            .map_err(failure)?;
        if changed.is_empty() {
            return Ok(());
        }
        let index = self.repository.index_state(&changed).map_err(failure)?;
        let gitlinks = self
            .repository
            .gitlinks(&GitlinksRequest {
                before: self.tree.clone(),
                after: after.clone(),
                paths: changed.clone(),
            })
            .map_err(failure)?;
        history.snapshots.push(GitSnapshot {
            before: self.tree.clone(),
            after,
            paths: changed,
            index,
            gitlinks,
            forced: self.request.forced.clone(),
        });
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if !self.finished {
            let mut history = self
                .history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            history.busy = false;
            history.invalidate("a modifying operation was dropped before its snapshot settled");
        }
    }
}

fn paths(snapshots: &[GitSnapshot]) -> Vec<String> {
    snapshots
        .iter()
        .flat_map(|s| s.paths.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn transact(
    repository: &Repository,
    snapshots: &[GitSnapshot],
    reverse: bool,
    persist: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let ordered = if reverse {
        snapshots.iter().rev().collect::<Vec<_>>()
    } else {
        snapshots.iter().collect()
    };
    let mut completed = Vec::new();
    let result = (|| {
        for snapshot in ordered {
            repository
                .apply_snapshot(&ApplySnapshotRequest {
                    snapshot: snapshot.clone(),
                    reverse,
                })
                .map_err(failure)?;
            completed.push(snapshot);
        }
        persist()
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for snapshot in completed.into_iter().rev() {
            if let Err(error) = repository.apply_snapshot(&ApplySnapshotRequest {
                snapshot: snapshot.clone(),
                reverse: !reverse,
            }) {
                failures.push(error.to_string());
            }
        }
        return Err(if failures.is_empty() {
            error
        } else {
            failure(format!(
                "{error}; restoring the pre-move worktree also failed: {}",
                failures.join("; ")
            ))
        });
    }
    Ok(())
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}
