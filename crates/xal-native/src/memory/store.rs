use super::storage::*;
use super::*;

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
