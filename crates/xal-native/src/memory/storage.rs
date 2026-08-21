use super::*;

#[derive(Clone)]
pub struct Snapshot {
    pub(super) content: String,
    pub(super) revision: String,
}
pub(super) struct WriteLock {
    path: PathBuf,
    file: Option<File>,
}

impl WriteLock {
    pub(super) fn release(mut self) -> napi::Result<()> {
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

fn revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

pub(super) fn empty_snapshot() -> Snapshot {
    Snapshot {
        content: String::new(),
        revision: revision(""),
    }
}

pub(super) fn validate(content: String, secrets: &[String]) -> napi::Result<Snapshot> {
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

pub(super) fn read(path: &Path, secrets: &[String]) -> napi::Result<Snapshot> {
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
    let file = options
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
    let mut bytes = Vec::with_capacity(MAX_BYTES + 1);
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
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

pub(super) fn lock(path: &Path, cancelled: &AtomicBool) -> napi::Result<WriteLock> {
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

pub(super) fn secure_replace(path: &Path, content: &str) -> napi::Result<()> {
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
