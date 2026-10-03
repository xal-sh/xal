use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub content: String,
    pub revision: String,
}

pub(super) struct WriteLock {
    path: PathBuf,
    file: Option<File>,
}

impl WriteLock {
    pub(super) fn release(mut self) -> io::Result<()> {
        self.file.take();
        fs::remove_file(&self.path).map_err(|error| {
            io::Error::other(format!(
                "cannot remove global memory update lock {}: {error}",
                self.path.display()
            ))
        })
    }
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        if self.file.take().is_some()
            && let Err(error) = fs::remove_file(&self.path)
        {
            eprintln!(
                "cannot remove global memory update lock {}: {error}",
                self.path.display()
            );
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

pub(super) fn validate(content: String, protection: Protection<'_>) -> io::Result<Snapshot> {
    if content.len() > MAX_BYTES {
        return Err(invalid(format!(
            "global memory exceeds its {MAX_BYTES}-byte limit"
        )));
    }
    protection.check(&content)?;
    Ok(Snapshot {
        revision: revision(&content),
        content,
    })
}

pub(super) fn read(path: &Path, protection: Protection<'_>) -> io::Result<Snapshot> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(empty_snapshot()),
        Err(error) => return Err(error),
    };
    if path_metadata.file_type().is_symlink() {
        return Err(invalid("global memory path must not be a symbolic link"));
    }
    if !path_metadata.is_file() {
        return Err(invalid("global memory path is not a file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
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
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    let content =
        String::from_utf8(bytes).map_err(|_| invalid("global memory file is not valid UTF-8"))?;
    validate(content, protection)
}

pub(super) fn lock(path: &Path, cancelled: &AtomicBool) -> io::Result<WriteLock> {
    check(cancelled)?;
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    for attempt in 0..200 {
        check(cancelled)?;
        match crate::storage::create_secure(&lock_path) {
            Ok(file) => {
                return Ok(WriteLock {
                    path: lock_path,
                    file: Some(file),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempt < 199 => {
                thread::sleep(Duration::from_millis(25))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(io::Error::other(format!(
                    "global memory update lock timed out; remove {} if no update is running",
                    lock_path.display()
                )));
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("global memory update lock failed"))
}
