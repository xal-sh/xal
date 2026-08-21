use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use sha2::{Digest, Sha256};

use crate::tool_contracts::cancellation_flag;

const MAX_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub struct Snapshot {
    content: String,
    revision: String,
}

#[napi(object)]
pub struct NativeMemorySnapshot {
    pub content: String,
    pub revision: String,
}

#[napi]
pub struct NativeMemoryStore {
    path: PathBuf,
    snapshot: Arc<Mutex<Snapshot>>,
}

enum Operation {
    Load,
    Replace { content: String, expected: String },
}

pub struct MemoryTask {
    path: PathBuf,
    snapshot: Arc<Mutex<Snapshot>>,
    secrets: Vec<String>,
    cancelled: Arc<AtomicBool>,
    operation: Operation,
}

struct WriteLock {
    path: PathBuf,
    file: Option<File>,
}

impl WriteLock {
    fn release(mut self) -> napi::Result<()> {
        self.file.take();
        fs::remove_file(&self.path).map_err(|error| {
            failed(format!(
                "cannot remove global memory update lock {}: {error}",
                self.path.display()
            ))
        })
    }
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        self.file.take();
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn empty_snapshot() -> Snapshot {
    Snapshot {
        content: String::new(),
        revision: revision(""),
    }
}

fn validate(content: String, secrets: &[String]) -> napi::Result<Snapshot> {
    if content.len() > MAX_BYTES {
        return Err(invalid(format!(
            "global memory exceeds its {MAX_BYTES}-byte limit"
        )));
    }
    if secrets
        .iter()
        .any(|secret| !secret.is_empty() && content.contains(secret))
    {
        return Err(invalid(
            "global memory contains a configured secret and cannot be used",
        ));
    }
    Ok(Snapshot {
        revision: revision(&content),
        content,
    })
}

fn read(path: &Path, secrets: &[String]) -> napi::Result<Snapshot> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty_snapshot()),
        Err(error) => return Err(failed(error.to_string())),
    };
    if path_metadata.file_type().is_symlink() {
        return Err(invalid("global memory path must not be a symbolic link"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .map_err(|error| failed(error.to_string()))?;
    let metadata = file.metadata().map_err(|error| failed(error.to_string()))?;
    if metadata.file_type().is_symlink() {
        return Err(invalid("global memory path must not be a symbolic link"));
    }
    if !metadata.is_file() {
        return Err(invalid("global memory path is not a file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid("global memory file permissions must be 0600"));
        }
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| failed(error.to_string()))?;
    let content =
        String::from_utf8(bytes).map_err(|_| invalid("global memory file is not valid UTF-8"))?;
    validate(content, secrets)
}

fn open_secure(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn lock(path: &Path, cancelled: &AtomicBool) -> napi::Result<WriteLock> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failed(error.to_string()))?;
    }
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    for attempt in 0..200 {
        if cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "The operation was aborted"));
        }
        match open_secure(&lock_path) {
            Ok(file) => {
                return Ok(WriteLock {
                    path: lock_path,
                    file: Some(file),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 199 => {
                thread::sleep(Duration::from_millis(25))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(failed(format!(
                    "global memory update lock timed out; remove {} if no update is running",
                    lock_path.display()
                )));
            }
            Err(error) => return Err(failed(error.to_string())),
        }
    }
    Err(failed("global memory update lock failed"))
}

fn secure_replace(path: &Path, content: &str) -> napi::Result<()> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        stamp
    ));
    let mut file = open_secure(&temporary).map_err(|error| failed(error.to_string()))?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        return match fs::remove_file(&temporary) {
            Ok(()) => Err(failed(error.to_string())),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => {
                Err(failed(error.to_string()))
            }
            Err(cleanup) => Err(failed(format!(
                "{error}; cannot remove temporary global memory file {}: {cleanup}",
                temporary.display()
            ))),
        };
    }
    Ok(())
}

impl Task for MemoryTask {
    type JsValue = NativeMemorySnapshot;
    type Output = Snapshot;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "The operation was aborted"));
        }
        let next = match &self.operation {
            Operation::Load => read(&self.path, &self.secrets)?,
            Operation::Replace { content, expected } => {
                let write_lock = lock(&self.path, &self.cancelled)?;
                let result = (|| {
                    let current = read(&self.path, &self.secrets)?;
                    if current.revision != *expected {
                        *self
                            .snapshot
                            .lock()
                            .map_err(|_| failed("native memory snapshot lock failed"))? = current;
                        return Err(invalid(
                            "global memory changed since it was read; read it again before replacing it",
                        ));
                    }
                    let next = validate(content.clone(), &self.secrets)?;
                    if self.cancelled.load(Ordering::Relaxed) {
                        return Err(Error::new(Status::Cancelled, "The operation was aborted"));
                    }
                    if next.content != current.content {
                        secure_replace(&self.path, &next.content)?;
                    }
                    Ok(next)
                })();
                let release = write_lock.release();
                match (result, release) {
                    (Ok(next), Ok(())) => next,
                    (Err(error), Ok(())) => return Err(error),
                    (Ok(_), Err(error)) => return Err(error),
                    (Err(error), Err(release)) => {
                        return Err(failed(format!("{}; {}", error.reason, release.reason)));
                    }
                }
            }
        };
        *self
            .snapshot
            .lock()
            .map_err(|_| failed("native memory snapshot lock failed"))? = next.clone();
        Ok(next)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeMemorySnapshot {
            content: output.content,
            revision: output.revision,
        })
    }
}

#[napi]
impl NativeMemoryStore {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> Self {
        Self {
            path: PathBuf::from(path),
            snapshot: Arc::new(Mutex::new(empty_snapshot())),
        }
    }

    #[napi(getter, catch_unwind)]
    pub fn prompt_content(&self) -> napi::Result<String> {
        Ok(self
            .snapshot
            .lock()
            .map_err(|_| failed("native memory snapshot lock failed"))?
            .content
            .clone())
    }

    #[napi(catch_unwind)]
    pub fn load(&self, secrets: Vec<String>, signal: Option<AbortSignal>) -> AsyncTask<MemoryTask> {
        AsyncTask::new(MemoryTask {
            path: self.path.clone(),
            snapshot: self.snapshot.clone(),
            secrets,
            cancelled: cancellation_flag(signal),
            operation: Operation::Load,
        })
    }

    #[napi(catch_unwind)]
    pub fn replace(
        &self,
        content: String,
        expected_revision: String,
        secrets: Vec<String>,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<MemoryTask> {
        AsyncTask::new(MemoryTask {
            path: self.path.clone(),
            snapshot: self.snapshot.clone(),
            secrets,
            cancelled: cancellation_flag(signal),
            operation: Operation::Replace {
                content,
                expected: expected_revision,
            },
        })
    }
}
