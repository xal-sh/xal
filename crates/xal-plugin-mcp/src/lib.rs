pub mod config;
mod controller;
pub mod project;
mod tools;

pub use controller::{Confirmation, Controller};

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use xal_host::*;
use xal_services::{config::Configuration, redactor::Redactor};

pub struct Mcp {
    controller: Controller,
}

impl Mcp {
    pub fn new(
        configuration: &Configuration,
        home: PathBuf,
        cwd: PathBuf,
        redactor: Arc<Redactor>,
    ) -> Result<Self> {
        let parsed = match configuration.settings.plugin_config.get("mcp") {
            Some(values) => config::parse(values, &cwd),
            None => config::parse(&JsonObject::new(), &cwd),
        }
        .map_err(failure)?;
        redactor.protect(parsed.secrets).map_err(failure)?;
        let sources = project::sources(configuration, &home).map_err(failure)?;
        Ok(Self {
            controller: Controller::new(
                parsed.servers,
                home,
                configuration.project_root.clone(),
                sources,
                redactor,
            )?,
        })
    }

    pub fn controller(&self) -> Controller {
        self.controller.clone()
    }
}

impl Plugin for Mcp {
    fn name(&self) -> &str {
        "mcp"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        tools::register(registration, &self.controller)?;
        let controller = self.controller.clone();
        registration.dynamic_tools("mcp__", Box::new(move |_| controller.tools()))?;
        let controller = self.controller.clone();
        registration.prompt_source(
            "mcp",
            Box::new(move |session| controller.instructions(&session.id)),
        )?;
        let controller = self.controller.clone();
        registration.command_async("mcp", "view and manage MCP servers", move |args, cancel| {
            let controller = controller.clone();
            Box::pin(async move { controller.command(&args, &cancel).await })
        })?;
        let controller = self.controller.clone();
        registration.session_disposer(Box::new(move |(), context| {
            let result = controller.dispose_session(&context.session.id);
            Box::pin(async { result })
        }));
        registration.policy(
            "mcp",
            Box::new(|request, _| {
                Box::pin(async move {
                    Ok(
                        if request.tool.starts_with("mcp__")
                            || [
                                "mcp_tool_search",
                                "mcp_resources",
                                "mcp_prompts",
                                "mcp_read_resource",
                                "mcp_get_prompt",
                            ]
                            .contains(&request.tool.as_str())
                        {
                            PolicyDecision::Allow
                        } else {
                            PolicyDecision::Abstain
                        },
                    )
                })
            }),
        )
    }

    fn bootstrap<'a>(&'a mut self, registration: &'a mut Registration) -> Call<'a, ()> {
        Box::pin(async move {
            let cancellation = registration.cancellation();
            self.controller.connect(&cancellation).await?;
            for server in self.controller.servers()? {
                if server.warning.is_some() {
                    registration.warning(self.controller.redactor.redact(&server.line()))?;
                }
            }
            let controller = self.controller.clone();
            registration.spawn(async move {
                loop {
                    tokio::select! {
                        () = cancellation.cancelled() => return Ok(()),
                        () = tokio::time::sleep(Duration::from_millis(250)) => {}
                    }
                    match controller.refresh(&cancellation).await {
                        Err(Error::Cancelled) => return Ok(()),
                        result => result?,
                    }
                }
            })
        })
    }

    fn shutdown(&mut self) -> Call<'_, ()> {
        Box::pin(async { self.controller.close().await })
    }
}

struct CancelFlag(Arc<AtomicBool>);

impl Drop for CancelFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn cancellable<T>(
    cancel: &Cancellation,
    flag: Arc<AtomicBool>,
    operation: impl Future<Output = std::io::Result<T>>,
) -> Result<T> {
    cancel.check()?;
    let guard = CancelFlag(flag);
    tokio::pin!(operation);
    tokio::select! {
        biased;
        () = cancel.cancelled() => {
            guard.0.store(true, Ordering::Relaxed);
            match operation.await {
                Ok(_) => Err(Error::Cancelled),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => Err(Error::Cancelled),
                Err(error) => Err(failure(error)),
            }
        }
        result = &mut operation => result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::Interrupted { Error::Cancelled } else { failure(error) }
        }),
    }
}

fn failure(error: impl std::fmt::Display) -> Error {
    Error::Failed(error.to_string())
}

fn invalid(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())
}
