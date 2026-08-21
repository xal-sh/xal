use super::*;

pub(super) async fn connect_entry(
    state: Arc<Mutex<ManagerState>>,
    id: String,
    cancelled: Arc<AtomicBool>,
) -> napi::Result<()> {
    let (config, generation, handler) = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let entry = manager
            .entries
            .get_mut(&id)
            .ok_or_else(|| failed(format!("unknown MCP server: {id}")))?;
        if !entry.config.enabled() {
            return Err(failed(format!("MCP server is disabled: {id}")));
        }
        entry.generation += 1;
        entry.state = "connecting".to_owned();
        entry.error = None;
        (
            entry.config.clone(),
            entry.generation,
            Handler {
                state: entry.handler.clone(),
                info: client_info(
                    format!("{}-{id}", manager.app_name),
                    manager.app_version.clone(),
                ),
            },
        )
    };
    let result = async {
        let (service, transport) = connect_service(&config, handler, &cancelled).await?;
        let peer = service.peer().clone();
        let discovered = cancellable(
            config.timeout(),
            "MCP discovery",
            &cancelled,
            discover(&peer, &config),
        )
        .await?;
        Ok::<_, Error>((service, peer, transport, discovered))
    }
    .await;
    let mut result = Some(result);
    let old_service = {
        let mut manager = lock(&state);
        let is_current = manager
            .entries
            .get(&id)
            .is_some_and(|entry| entry.generation == generation);
        if !is_current {
            result
                .take()
                .and_then(Result::ok)
                .map(|(service, _, _, _)| service)
        } else {
            let entry = manager.entries.get_mut(&id).expect("current entry exists");
            let old = match result.take().expect("connection result exists") {
                Ok((service, peer, transport, discovered)) => {
                    let old = entry.service.take();
                    entry.service = Some(service);
                    entry.peer = Some(peer.clone());
                    entry.connection_transport = Some(transport);
                    entry.state = "connected".to_owned();
                    entry.error = None;
                    entry.tools = discovered.0;
                    entry.resources = discovered.1;
                    entry.templates = discovered.2;
                    entry.prompts = discovered.3;
                    entry.skipped_task_tools = discovered.4;
                    entry.skipped_output_tools = discovered.5;
                    entry.instructions =
                        peer.peer_info().and_then(|info| info.instructions.clone());
                    entry.seen_tool_revision = entry.handler.tool_revision.load(Ordering::Relaxed);
                    entry.seen_resource_revision =
                        entry.handler.resource_revision.load(Ordering::Relaxed);
                    entry.seen_prompt_revision =
                        entry.handler.prompt_revision.load(Ordering::Relaxed);
                    old
                }
                Err(error) => {
                    let old = entry.service.take();
                    entry.peer = None;
                    entry.connection_transport = None;
                    entry.state = "failed".to_owned();
                    entry.error = Some(error.to_string());
                    entry.tools.clear();
                    entry.resources.clear();
                    entry.templates.clear();
                    entry.prompts.clear();
                    old
                }
            };
            manager.tool_revision += 1;
            old
        }
    };
    if let Some(mut service) = old_service {
        let _ = close_service(&mut service).await;
    }
    Ok(())
}

pub(super) async fn refresh_entry(state: Arc<Mutex<ManagerState>>, id: String) -> napi::Result<()> {
    let (peer, config, generation, tool_changed, resource_changed, prompt_changed) = {
        let manager = lock(&state);
        let Some(entry) = manager.entries.get(&id) else {
            return Ok(());
        };
        if entry.state != "connected" {
            return Ok(());
        }
        let Some(peer) = entry.peer.clone() else {
            return Ok(());
        };
        (
            peer,
            entry.config.clone(),
            entry.generation,
            entry.handler.tool_revision.load(Ordering::Relaxed) != entry.seen_tool_revision,
            entry.handler.resource_revision.load(Ordering::Relaxed) != entry.seen_resource_revision,
            entry.handler.prompt_revision.load(Ordering::Relaxed) != entry.seen_prompt_revision,
        )
    };
    if !tool_changed && !resource_changed && !prompt_changed {
        return Ok(());
    }
    let tools = if tool_changed {
        Some(tool_records(
            config.id(),
            list_tools(&peer, config.timeout()).await?,
        )?)
    } else {
        None
    };
    let resources = if resource_changed {
        Some((
            json_values(&list_resources(&peer, config.timeout()).await?)?,
            json_values(&list_templates(&peer, config.timeout()).await?)?,
        ))
    } else {
        None
    };
    let prompts = if prompt_changed {
        Some(json_values(&list_prompts(&peer, config.timeout()).await?)?)
    } else {
        None
    };
    let mut manager = lock(&state);
    let Some(entry) = manager.entries.get_mut(&id) else {
        return Ok(());
    };
    if entry.generation != generation || entry.state != "connected" {
        return Ok(());
    }
    let tools_changed = tools.is_some();
    if let Some((tools, skipped_tasks, skipped_output)) = tools {
        entry.tools = tools;
        entry.skipped_task_tools = skipped_tasks;
        entry.skipped_output_tools = skipped_output;
        entry.seen_tool_revision = entry.handler.tool_revision.load(Ordering::Relaxed);
    }
    if let Some((resources, templates)) = resources {
        entry.resources = resources;
        entry.templates = templates;
        entry.seen_resource_revision = entry.handler.resource_revision.load(Ordering::Relaxed);
    }
    if let Some(prompts) = prompts {
        entry.prompts = prompts;
        entry.seen_prompt_revision = entry.handler.prompt_revision.load(Ordering::Relaxed);
    }
    entry.error = None;
    if tools_changed {
        manager.tool_revision += 1;
    }
    Ok(())
}
pub(super) fn connected_peer(
    state: &Arc<Mutex<ManagerState>>,
    server: &str,
    capability: &str,
) -> napi::Result<(Peer<RoleClient>, Duration)> {
    let manager = lock(state);
    let entry = manager
        .entries
        .get(server)
        .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
    if entry.state != "connected" {
        return Err(failed(format!("MCP server is not connected: {server}")));
    }
    let peer = entry
        .peer
        .clone()
        .ok_or_else(|| failed(format!("MCP server is not connected: {server}")))?;
    if !has_capability(&peer, capability) {
        return Err(failed(format!(
            "MCP server does not provide {capability}: {server}"
        )));
    }
    Ok((peer, entry.config.timeout()))
}

pub(super) async fn remove_entry(
    state: Arc<Mutex<ManagerState>>,
    server: &str,
) -> napi::Result<()> {
    let service = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let mut entry = manager
            .entries
            .remove(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        manager.order.retain(|id| id != server);
        if !entry.tools.is_empty() {
            manager.tool_revision += 1;
        }
        entry.service.take()
    };
    if let Some(mut service) = service {
        close_service(&mut service).await?;
    }
    Ok(())
}

pub(super) async fn close_all(state: Arc<Mutex<ManagerState>>) -> napi::Result<()> {
    let services = {
        let mut manager = lock(&state);
        manager.closing = true;
        let mut services = Vec::new();
        let mut changed = false;
        for entry in manager.entries.values_mut() {
            changed |= !entry.tools.is_empty();
            if let Some(service) = entry.service.take() {
                services.push((entry.config.id().to_owned(), service));
            }
            entry.peer = None;
            entry.connection_transport = None;
            entry.state = if entry.config.enabled() {
                "idle".to_owned()
            } else {
                "disabled".to_owned()
            };
            entry.tools.clear();
            entry.resources.clear();
            entry.templates.clear();
            entry.prompts.clear();
            entry.instructions = None;
        }
        if changed {
            manager.tool_revision += 1;
        }
        services
    };
    let mut failures = Vec::new();
    for (id, mut service) in services {
        if let Err(error) = close_service(&mut service).await {
            failures.push(format!("{id}: {error}"));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(failed(failures.join("; ")))
}
