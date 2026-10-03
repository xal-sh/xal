use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use xal_host::*;
use xal_services::mcp::{McpManager, ServerConfig, ServerStatus, ToolDescriptor};
use xal_services::redactor::Redactor;

use crate::{cancellable, failure, project, tools};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirmation {
    Confirm,
    Cancel,
}

#[derive(Default)]
struct Catalog {
    revision: Option<u64>,
    descriptors: Vec<ToolDescriptor>,
    tools: BTreeMap<String, Arc<Tool>>,
    warning: Option<String>,
}

struct Deletion {
    task: tokio::task::JoinHandle<Result<project::Source>>,
}

#[derive(Clone)]
pub struct Controller {
    pub(crate) manager: McpManager,
    pub(crate) redactor: Arc<Redactor>,
    pub(crate) exposed: Arc<Mutex<BTreeMap<String, BTreeSet<String>>>>,
    pub(crate) gate: Arc<tokio::sync::RwLock<()>>,
    catalog: Arc<Mutex<Catalog>>,
    sources: Arc<Mutex<BTreeMap<String, project::Source>>>,
    deletion: Arc<tokio::sync::Mutex<Option<Deletion>>>,
    home: PathBuf,
    root: PathBuf,
}

impl Controller {
    pub(crate) fn new(
        configs: Vec<ServerConfig>,
        home: PathBuf,
        root: PathBuf,
        sources: BTreeMap<String, project::Source>,
        redactor: Arc<Redactor>,
    ) -> Result<Self> {
        Ok(Self {
            manager: McpManager::new(configs, "xal".into(), env!("CARGO_PKG_VERSION").into())
                .map_err(failure)?,
            redactor,
            exposed: Arc::default(),
            gate: Arc::default(),
            catalog: Arc::default(),
            sources: Arc::new(Mutex::new(sources)),
            deletion: Arc::default(),
            home,
            root,
        })
    }

    pub fn servers(&self) -> Result<Vec<ServerStatus>> {
        let mut servers = self.manager.servers();
        if let Some(warning) = &lock(&self.catalog)?.warning
            && let Some(first) = servers.first_mut()
        {
            first.warning = Some(match &first.warning {
                Some(previous) => format!("{previous}; catalog refresh: {warning}"),
                None => format!("catalog refresh: {warning}"),
            });
        }
        for server in &mut servers {
            server.warning = server
                .warning
                .as_ref()
                .map(|warning| self.redactor.redact(warning));
        }
        Ok(servers)
    }

    pub fn status(&self, server: Option<&str>) -> Result<String> {
        let lines: Vec<_> = self
            .servers()?
            .iter()
            .filter(|status| server.is_none_or(|server| status.id == server))
            .map(ServerStatus::line)
            .collect();
        Ok(if lines.is_empty() {
            "No MCP servers configured.".into()
        } else {
            self.redactor.redact(&lines.join("\n"))
        })
    }

    pub async fn reconnect(&self, server: Option<&str>, cancel: &Cancellation) -> Result<String> {
        let _mutation = self.gate.try_write().map_err(|_| {
            failure("finish or interrupt the current work before changing MCP servers")
        })?;
        let flag = Arc::new(AtomicBool::new(false));
        cancellable(cancel, flag.clone(), self.manager.reconnect(server, flag))
            .await
            .map_err(|error| self.host_error(error))?;
        self.sync()?;
        self.status(server)
    }

    pub async fn delete(
        &self,
        server: &str,
        confirmation: Confirmation,
        cancel: &Cancellation,
    ) -> Result<Option<project::Source>> {
        if confirmation == Confirmation::Cancel {
            return Ok(None);
        }
        cancel.check()?;
        let mutation = self.gate.clone().try_write_owned().map_err(|_| {
            failure("finish or interrupt the current work before changing MCP servers")
        })?;
        let mut deletion = self.deletion.lock().await;
        settle_deletion(&mut deletion).await?;
        cancel.check()?;
        let source = lock(&self.sources)?
            .get(server)
            .copied()
            .ok_or_else(|| failure(format!("unknown MCP server: {server}")))?;
        let home = self.home.clone();
        let root = self.root.clone();
        let id = server.to_owned();
        let controller = self.clone();
        *deletion = Some(Deletion {
            task: tokio::spawn(async move {
                let _mutation = mutation;
                let server = id.clone();
                tokio::task::spawn_blocking(move || project::delete(&home, &root, &id, source))
                    .await
                    .map_err(failure)?
                    .map_err(|error| controller.error(error))?;
                let removed = controller.manager.remove(&server).await;
                lock(&controller.sources)?.remove(&server);
                controller.sync()?;
                removed.map_err(|error| controller.error(error))?;
                Ok(source)
            }),
        });
        settle_deletion(&mut deletion).await
    }

    pub async fn command(&self, args: &[String], cancel: &Cancellation) -> Result<String> {
        match args {
            [] => self.status(None),
            [action] if action == "reconnect" => self.reconnect(None, cancel).await,
            [action, server] if action == "reconnect" => self.reconnect(Some(server), cancel).await,
            [action, server, confirmation] if action == "delete" && confirmation == "--confirm" => {
                let source = self
                    .delete(server, Confirmation::Confirm, cancel)
                    .await?
                    .ok_or_else(|| failure("MCP deletion was cancelled"))?;
                Ok(format!(
                    "deleted {} · {}",
                    self.redactor.redact(server),
                    source.as_str()
                ))
            }
            [action, _] if action == "delete" => Err(Error::ApprovalRequired(
                "MCP deletion requires explicit confirmation: /mcp delete <server> --confirm"
                    .into(),
            )),
            _ => Err(failure(
                "usage: /mcp [reconnect [server] | delete <server> --confirm]",
            )),
        }
    }

    pub(crate) fn tools(&self) -> Result<BTreeMap<String, Arc<Tool>>> {
        Ok(lock(&self.catalog)?.tools.clone())
    }
    pub(crate) fn has_tools(&self) -> Result<bool> {
        Ok(!lock(&self.catalog)?.tools.is_empty())
    }

    pub(crate) fn search(&self, session: &str, query: &str, limit: usize) -> Result<String> {
        let normalized = query.trim().to_lowercase();
        let terms: BTreeSet<_> = normalized
            .split(|c: char| !c.is_alphanumeric())
            .filter(|term| !term.is_empty())
            .collect();
        if terms.is_empty() {
            return Err(failure("query must not be empty"));
        }
        if !(1..=20).contains(&limit) {
            return Err(failure("limit must be an integer from 1 to 20"));
        }
        let catalog = lock(&self.catalog)?;
        let mut matches: Vec<_> = catalog
            .descriptors
            .iter()
            .filter_map(|descriptor| {
                let name = format!(
                    "{} {} {}",
                    descriptor.server, descriptor.remote_name, descriptor.name
                )
                .to_lowercase();
                let text = format!("{name} {}", descriptor.description.to_lowercase());
                let score = if text.contains(&normalized) { 100 } else { 0 }
                    + terms
                        .iter()
                        .map(|term| {
                            if name.contains(term) {
                                10
                            } else if text.contains(term) {
                                1
                            } else {
                                0
                            }
                        })
                        .sum::<usize>();
                (score > 0).then_some((score, descriptor))
            })
            .collect();
        matches.sort_by(|(left_score, left), (right_score, right)| {
            right_score
                .cmp(left_score)
                .then_with(|| left.name.cmp(&right.name))
        });
        matches.truncate(limit);
        if matches.is_empty() {
            return Ok("No matching MCP tools found.".into());
        }
        let mut exposed = lock(&self.exposed)?;
        let exposed = exposed.entry(session.into()).or_default();
        let mut lines = vec!["Loaded MCP tools for the next model call:".into()];
        for (_, descriptor) in matches {
            exposed.insert(descriptor.name.clone());
            lines.push(format!("- {}", descriptor.name));
        }
        Ok(self.redactor.redact(&lines.join("\n")))
    }

    pub(crate) fn instructions(&self, session: &str) -> Result<String> {
        let catalog = lock(&self.catalog)?;
        let exposed = lock(&self.exposed)?;
        let Some(exposed) = exposed.get(session) else {
            return Ok(String::new());
        };
        let mut servers = BTreeSet::new();
        let mut sections = Vec::new();
        for descriptor in &catalog.descriptors {
            if !exposed.contains(&descriptor.name) || !servers.insert(&descriptor.server) {
                continue;
            }
            let instructions = self.manager.instructions(&descriptor.server);
            if !instructions.trim().is_empty() {
                sections.push(format!(
                    "MCP server {} instructions:\n{}",
                    descriptor.server,
                    instructions.trim()
                ));
            }
        }
        Ok(self.redactor.redact(&sections.join("\n\n")))
    }

    pub(crate) fn dispose_session(&self, session: &str) -> Result<()> {
        lock(&self.exposed)?.remove(session);
        Ok(())
    }

    pub(crate) async fn connect(&self, cancel: &Cancellation) -> Result<()> {
        let flag = Arc::new(AtomicBool::new(false));
        cancellable(cancel, flag.clone(), self.manager.connect_all(flag))
            .await
            .map_err(|error| self.host_error(error))?;
        self.sync()
    }

    pub(crate) async fn refresh(&self, cancel: &Cancellation) -> Result<()> {
        let flag = Arc::new(AtomicBool::new(false));
        let result = cancellable(cancel, flag.clone(), self.manager.refresh(flag)).await;
        self.sync()?;
        match result {
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(error) => {
                lock(&self.catalog)?.warning = Some(self.redactor.redact(&error.to_string()));
                Ok(())
            }
            Ok(()) => Ok(()),
        }
    }

    pub(crate) async fn close(&self) -> Result<()> {
        let deletion = settle_deletion(&mut *self.deletion.lock().await).await;
        let closed = self
            .manager
            .close()
            .await
            .map_err(|error| self.error(error));
        self.sync()?;
        lock(&self.exposed)?.clear();
        match (deletion, closed) {
            (Ok(_), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(left), Err(right)) => Err(failure(format!("{left}; {right}"))),
        }
    }

    fn sync(&self) -> Result<()> {
        let snapshot = self.manager.tool_descriptors();
        let mut catalog = lock(&self.catalog)?;
        if catalog.revision == Some(snapshot.revision) {
            catalog.warning = None;
            return Ok(());
        }
        let mut tools = BTreeMap::new();
        for descriptor in &snapshot.tools {
            let tool = tools::remote(self, descriptor);
            if tools
                .insert(descriptor.name.clone(), Arc::new(tool))
                .is_some()
            {
                return Err(failure(format!("duplicate MCP tool: {}", descriptor.name)));
            }
        }
        let mut exposed = lock(&self.exposed)?;
        for names in exposed.values_mut() {
            names.retain(|name| tools.contains_key(name));
        }
        exposed.retain(|_, names| !names.is_empty());
        *catalog = Catalog {
            revision: Some(snapshot.revision),
            descriptors: snapshot.tools,
            tools,
            warning: None,
        };
        Ok(())
    }

    pub(crate) fn host_error(&self, error: Error) -> Error {
        match error {
            Error::Cancelled => Error::Cancelled,
            error => self.error(error),
        }
    }

    pub(crate) fn error(&self, error: impl std::fmt::Display) -> Error {
        failure(self.redactor.redact(&error.to_string()))
    }
}

async fn settle_deletion(deletion: &mut Option<Deletion>) -> Result<Option<project::Source>> {
    let Some(pending) = deletion.as_mut() else {
        return Ok(None);
    };
    let result = (&mut pending.task).await;
    deletion.take();
    result.map_err(failure)?.map(Some)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| failure("MCP state poisoned"))
}
