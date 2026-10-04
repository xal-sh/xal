use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::paths::Paths;
use crate::storage::{create_secure, invalid, read_json, write_json};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Running,
    Done,
    NeedsInput,
    Failed,
    Stopped,
    Handoff,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub version: u8,
    pub app_version: String,
    pub session_id: String,
    pub session_path: PathBuf,
    pub cwd: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub log: PathBuf,
    pub pid: u32,
    pub worker_id: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Handoff,
    Stop,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub version: u8,
    pub worker_id: String,
    pub request_id: String,
    pub action: Action,
    pub requested_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub version: u8,
    pub session_id: String,
    pub worker_id: String,
    pub created_at: u64,
}

#[derive(Clone)]
pub struct Store {
    pub directory: PathBuf,
    pub id: String,
}

impl Store {
    pub fn new(home: &Path, id: &str) -> io::Result<Self> {
        Ok(Self {
            directory: Paths { home: home.into() }.background_session(id)?,
            id: id.into(),
        })
    }

    pub fn state(&self) -> io::Result<Option<State>> {
        let raw = read_json(&self.directory.join("state.json"))?;
        let raw = match raw {
            Some(raw) => Some(raw),
            None => match (
                self.lease()?,
                read_json(&self.directory.join("startup.json"))?,
            ) {
                (Some(lease), Some(raw)) if raw["workerId"] == lease.worker_id => Some(raw),
                _ => None,
            },
        };
        let state: Option<State> = raw.map(serde_json::from_value).transpose()?;
        if let Some(state) = &state
            && (state.version != 1
                || state.session_id != self.id
                || state.worker_id.is_empty()
                || state.pid == 0
                || state.updated_at < state.started_at)
        {
            return Err(invalid("malformed background state"));
        }
        Ok(state)
    }

    pub fn lease(&self) -> io::Result<Option<Lease>> {
        let lease: Option<Lease> = read_json(&self.directory.join("lease.json"))?
            .map(serde_json::from_value)
            .transpose()?;
        if let Some(lease) = &lease
            && (lease.version != 1 || lease.session_id != self.id || lease.worker_id.is_empty())
        {
            return Err(invalid("malformed background lease"));
        }
        Ok(lease)
    }

    pub fn assert_owner(&self, worker: &str) -> io::Result<()> {
        if self.lease()?.is_none_or(|lease| lease.worker_id != worker) {
            return Err(invalid("background worker no longer owns this lease"));
        }
        Ok(())
    }

    pub fn claim_start(&self, state: &State) -> io::Result<()> {
        if self.state()?.is_some() || self.lease()?.is_some() {
            return Err(invalid(
                "session already has a background entry; attach or clear it first",
            ));
        }
        write_json(
            &self.directory.join("startup.json"),
            &serde_json::to_value(state)?,
        )?;
        self.claim(&state.worker_id)
    }

    pub fn claim(&self, worker: &str) -> io::Result<()> {
        if self.state()?.is_some() {
            return Err(invalid(
                "session already has a background entry; attach or clear it first",
            ));
        }
        if worker.is_empty() {
            return Err(invalid("worker ID is empty"));
        }
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.directory)?;
        let path = self.directory.join("lease.json");
        let mut file = create_secure(&path)?;
        let result = (|| {
            file.write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&Lease {
                        version: 1,
                        session_id: self.id.clone(),
                        worker_id: worker.into(),
                        created_at: now()?
                    })?
                )
                .as_bytes(),
            )?;
            file.sync_all()
        })();
        drop(file);
        if let Err(error) = result {
            std::fs::remove_file(path)
                .map_err(|cleanup| invalid(format!("{error}; lease rollback failed: {cleanup}")))?;
            return Err(error);
        }
        Ok(())
    }

    pub fn release(&self, worker: &str) -> io::Result<()> {
        self.assert_owner(worker)?;
        std::fs::remove_file(self.directory.join("lease.json"))
    }

    pub fn publish(&self, state: &State) -> io::Result<()> {
        self.assert_owner(&state.worker_id)?;
        if state.session_id != self.id || state.version != 1 {
            return Err(invalid("background state identity changed"));
        }
        write_json(
            &self.directory.join("state.json"),
            &serde_json::to_value(state)?,
        )
    }

    pub fn control(&self, worker: &str) -> io::Result<Option<Control>> {
        let control: Option<Control> = read_json(&self.directory.join("control.json"))?
            .map(serde_json::from_value)
            .transpose()?;
        if let Some(control) = &control
            && (control.version != 1
                || control.request_id.is_empty()
                || control.worker_id.is_empty())
        {
            return Err(invalid("malformed background control request"));
        }
        Ok(control.filter(|control| control.worker_id == worker))
    }

    pub fn request(&self, worker: &str, action: Action) -> io::Result<()> {
        self.assert_owner(worker)?;
        write_json(
            &self.directory.join("control.json"),
            &serde_json::to_value(Control {
                version: 1,
                worker_id: worker.into(),
                request_id: crate::credentials::new_id()?,
                action,
                requested_at: now()?,
            })?,
        )
    }

    pub fn claim_attach(&self) -> io::Result<Attach> {
        let path = self.directory.join("attach.lock");
        let file = create_secure(&path).map_err(|error| io::Error::new(error.kind(), format!("cannot attach; another client may be attaching (clear stale entries only after the worker stops): {error}")))?;
        Ok(Attach {
            path,
            file: Some(file),
        })
    }

    pub fn remove(&self) -> io::Result<()> {
        if self
            .state()?
            .map(|state| alive(state.pid))
            .transpose()?
            .unwrap_or(false)
        {
            return Err(invalid("background process is still alive; stop it first"));
        }
        std::fs::remove_dir_all(&self.directory)
    }
}

pub struct Attach {
    path: PathBuf,
    file: Option<File>,
}
impl Attach {
    pub fn release(mut self) -> io::Result<()> {
        self.file.take();
        remove_lock(&self.path)
    }
}
impl Drop for Attach {
    fn drop(&mut self) {
        if self.file.take().is_some()
            && let Err(error) = remove_lock(&self.path)
        {
            eprintln!("background attach lock cleanup failed: {error}");
        }
    }
}
fn remove_lock(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[derive(Clone, Debug)]
pub enum Entry {
    Worker(State),
    Unpublished(Lease),
}

impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Self::Worker(state) => &state.session_id,
            Self::Unpublished(lease) => &lease.session_id,
        }
    }
}

pub fn list(home: &Path) -> io::Result<Vec<Entry>> {
    let entries = match std::fs::read_dir(home.join("bg")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut states = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry
            .file_name()
            .into_string()
            .map_err(|_| invalid("background session ID is not Unicode"))?;
        let store = Store::new(home, &id)?;
        if let Some(state) = store.state()? {
            states.push(Entry::Worker(state));
        } else if let Some(lease) = store.lease()? {
            states.push(Entry::Unpublished(lease));
        }
    }
    states.sort_by_key(|entry| {
        std::cmp::Reverse(match entry {
            Entry::Worker(state) => state.updated_at,
            Entry::Unpublished(lease) => lease.created_at,
        })
    });
    Ok(states)
}

pub fn find(home: &Path, id: &str) -> io::Result<Entry> {
    let mut states = list(home)?;
    if let Some(position) = states.iter().position(|state| state.id() == id) {
        return Ok(states.remove(position));
    }
    states.retain(|state| state.id().starts_with(id));
    if states.len() != 1 {
        return Err(invalid("background session prefix is missing or ambiguous"));
    }
    Ok(states.remove(0))
}

pub fn spawn(executable: &Path, args: &[String], cwd: &Path, log: File) -> io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    command.spawn()
}

#[cfg(unix)]
pub fn alive(pid: u32) -> io::Result<bool> {
    let pid = i32::try_from(pid).map_err(|_| invalid("invalid process ID"))?;
    if pid <= 0 {
        return Err(invalid("invalid process ID"));
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(true);
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(windows)]
pub fn alive(pid: u32) -> io::Result<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error().map(|value| value as u32) {
            Some(ERROR_INVALID_PARAMETER) => Ok(false),
            Some(ERROR_ACCESS_DENIED) => Ok(true),
            _ => Err(error),
        };
    }
    let mut code = 0;
    let result = unsafe { GetExitCodeProcess(handle, &mut code) };
    let error = io::Error::last_os_error();
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        return Err(error);
    }
    Ok(code == 259)
}

pub fn now() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis()
        .try_into()
        .map_err(io::Error::other)
}
