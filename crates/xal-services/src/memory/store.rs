use super::storage::*;
use super::*;

pub struct Store {
    path: PathBuf,
    snapshot: Mutex<Snapshot>,
    operation: Mutex<()>,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            snapshot: Mutex::new(empty_snapshot()),
            operation: Mutex::new(()),
        }
    }

    pub fn prompt_content(&self, protection: Protection<'_>) -> io::Result<String> {
        let snapshot = self
            .snapshot
            .lock()
            .map_err(|_| io::Error::other("memory snapshot lock failed"))?;
        protection.check(&snapshot.content)?;
        Ok(snapshot.content.clone())
    }

    fn publish(&self, snapshot: Snapshot) -> io::Result<Snapshot> {
        *self
            .snapshot
            .lock()
            .map_err(|_| io::Error::other("memory snapshot lock failed"))? = snapshot.clone();
        Ok(snapshot)
    }

    fn acquire(&self, cancelled: &AtomicBool) -> io::Result<std::sync::MutexGuard<'_, ()>> {
        loop {
            check(cancelled)?;
            match self.operation.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::WouldBlock) => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(io::Error::other("memory operation lock failed"));
                }
            }
        }
    }

    pub fn load(&self, protection: Protection<'_>, cancelled: &AtomicBool) -> io::Result<Snapshot> {
        let _operation = self.acquire(cancelled)?;
        let next = read(&self.path, protection)?;
        check(cancelled)?;
        self.publish(next)
    }

    pub fn replace(
        &self,
        content: String,
        expected: &str,
        protection: Protection<'_>,
        cancelled: &AtomicBool,
    ) -> io::Result<Snapshot> {
        let _operation = self.acquire(cancelled)?;
        let write_lock = lock(&self.path, cancelled)?;
        let result = (|| {
            let current = read(&self.path, protection)?;
            if current.revision != expected {
                self.publish(current)?;
                return Err(invalid(
                    "global memory changed since it was read; read it again before replacing it",
                ));
            }
            let next = validate(content, protection)?;
            check(cancelled)?;
            if next.content != current.content {
                crate::storage::write_text(&self.path, &next.content)?;
            }
            self.publish(next)
        })();
        match (result, write_lock.release()) {
            (Ok(next), Ok(())) => Ok(next),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(release)) => Err(io::Error::other(format!("{error}; {release}"))),
        }
    }
}
