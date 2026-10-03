use super::*;

#[napi(object)]
pub struct NativeMemorySnapshot {
    pub content: String,
    pub revision: String,
}

#[napi]
pub struct NativeMemoryStore {
    store: Arc<Store>,
}

enum Operation {
    Load,
    Replace { content: String, expected: String },
}

pub struct MemoryTask {
    store: Arc<Store>,
    secrets: Vec<String>,
    cancelled: Arc<AtomicBool>,
    operation: Operation,
}

impl Task for MemoryTask {
    type JsValue = NativeMemorySnapshot;
    type Output = Snapshot;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        match &self.operation {
            Operation::Load => self
                .store
                .load(Protection::Secrets(&self.secrets), &self.cancelled),
            Operation::Replace { content, expected } => self.store.replace(
                content.clone(),
                expected,
                Protection::Secrets(&self.secrets),
                &self.cancelled,
            ),
        }
        .map_err(boundary)
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
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
            store: Arc::new(Store::new(path.into())),
        }
    }

    #[napi(getter, catch_unwind)]
    pub fn prompt_content(&self) -> napi::Result<String> {
        self.store
            .prompt_content(Protection::Secrets(&[]))
            .map_err(boundary)
    }

    #[napi(catch_unwind)]
    pub fn load(&self, secrets: Vec<String>, signal: Option<AbortSignal>) -> AsyncTask<MemoryTask> {
        AsyncTask::new(MemoryTask {
            store: self.store.clone(),
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
            store: self.store.clone(),
            secrets,
            cancelled: cancellation_flag(signal),
            operation: Operation::Replace {
                content,
                expected: expected_revision,
            },
        })
    }
}
