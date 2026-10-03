use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use xal_services::lsp::{Manager, Query};

use crate::tool_contracts::cancellation_flag;

fn native_error(error: std::io::Error) -> Error {
    Error::new(
        if error.kind() == std::io::ErrorKind::InvalidInput {
            Status::InvalidArg
        } else {
            Status::GenericFailure
        },
        error.to_string(),
    )
}

#[napi]
pub struct NativeLspManager {
    manager: Arc<Manager>,
}

pub struct QueryTask {
    manager: Arc<Manager>,
    request: String,
    cwd: String,
    cancelled: Arc<AtomicBool>,
}

impl Task for QueryTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<String> {
        let query: Query = serde_json::from_str(&self.request).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("invalid native LSP request: {error}"),
            )
        })?;
        self.manager
            .query(&query, Path::new(&self.cwd), &|| {
                self.cancelled.load(Ordering::Acquire)
            })
            .map_err(native_error)
    }

    fn resolve(&mut self, _env: Env, output: String) -> napi::Result<String> {
        Ok(output)
    }
}

pub struct ActionTask {
    manager: Arc<Manager>,
    action: Action,
}

enum Action {
    Restart(Option<String>),
    Close,
}

impl Task for ActionTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        match &self.action {
            Action::Restart(server) => self.manager.restart(server.as_deref()),
            Action::Close => self.manager.close(),
        }
        .map_err(native_error)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

#[napi]
impl NativeLspManager {
    #[napi(constructor, catch_unwind)]
    pub fn new(definitions: String, app_name: String, app_version: String) -> napi::Result<Self> {
        let definitions = serde_json::from_str(&definitions).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("invalid native LSP configuration: {error}"),
            )
        })?;
        Ok(Self {
            manager: Arc::new(
                Manager::new(definitions, app_name, app_version).map_err(native_error)?,
            ),
        })
    }

    #[napi(catch_unwind)]
    pub fn has_available_server(&self, cwd: String) -> bool {
        self.manager.has_available_server(Path::new(&cwd))
    }

    #[napi(catch_unwind)]
    pub fn status_lines(&self, cwd: String) -> Vec<String> {
        self.manager.status_lines(Path::new(&cwd))
    }

    #[napi(catch_unwind)]
    pub fn query(
        &self,
        request: String,
        cwd: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<QueryTask> {
        AsyncTask::new(QueryTask {
            manager: self.manager.clone(),
            request,
            cwd,
            cancelled: cancellation_flag(signal),
        })
    }

    #[napi(catch_unwind)]
    pub fn restart(&self, server: Option<String>) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            manager: self.manager.clone(),
            action: Action::Restart(server),
        })
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> AsyncTask<ActionTask> {
        AsyncTask::new(ActionTask {
            manager: self.manager.clone(),
            action: Action::Close,
        })
    }
}
