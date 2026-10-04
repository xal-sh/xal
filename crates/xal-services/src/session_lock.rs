use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::storage::create_lock;
#[cfg(unix)]
use crate::storage::create_secure as create_lock;
use crate::storage::invalid;

pub struct SessionLock {
    file: File,
    path: PathBuf,
}

impl SessionLock {
    pub fn acquire(journal: &Path) -> io::Result<Self> {
        let parent = journal
            .parent()
            .ok_or_else(|| invalid("session path has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let parent = parent.canonicalize()?;
        let name = journal
            .file_name()
            .ok_or_else(|| invalid("session path has no filename"))?;
        let path = parent.join(name);
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        let lock_path = parent.join(lock_name);
        let file = match create_lock(&lock_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                open_existing(&lock_path)?
            }
            Err(error) => return Err(error),
        };
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => io::Error::new(
                io::ErrorKind::WouldBlock,
                "session already has a transcript owner",
            ),
            std::fs::TryLockError::Error(error) => error,
        })?;
        Ok(Self { file, path })
    }

    pub fn wait(path: &Path, timeout: std::time::Duration) -> io::Result<Self> {
        let started = std::time::Instant::now();
        loop {
            match Self::acquire(path) {
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && started.elapsed() < timeout =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                result => return result,
            }
        }
    }

    pub fn open(&self) -> io::Result<File> {
        let _ = &self.file;
        open_existing(&self.path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn open_existing(path: &Path) -> io::Result<File> {
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(invalid(
            "session storage must be a regular file, not a symlink",
        ));
    }
    let mut options = OpenOptions::new();
    options.write(true);
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
    if !file.metadata()?.is_file() {
        return Err(invalid("session storage must be a regular file"));
    }
    Ok(file)
}
