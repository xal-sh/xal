use super::*;

pub(super) async fn connect_entry(
    state: Arc<Mutex<ManagerState>>,
    id: String,
    cancelled: Arc<AtomicBool>,
) -> io::Result<()> {
    let (config, generation, handler, old_service, calls) = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let info = client_info(
            format!("{}-{id}", manager.app_name),
            manager.app_version.clone(),
        );
        let entry = manager
            .entries
            .get_mut(&id)
            .ok_or_else(|| failed(format!("unknown MCP server: {id}")))?;
        if !entry.config.enabled() {
            return Err(failed(format!("MCP server is disabled: {id}")));
        }
        entry.generation += 1;
        entry.state = ConnectionState::Connecting;
        entry.error = None;
        entry.clear_catalogs();
        entry.handler = Arc::default();
        let values = (
            entry.config.clone(),
            entry.generation,
            Handler {
                state: entry.handler.clone(),
                info,
            },
            entry.service.take(),
            std::mem::take(&mut entry.calls),
        );
        manager.tool_revision += 1;
        values
    };
    let result = async {
        stop_connection(old_service, calls).await?;
        let (mut service, transport, stderr) =
            connect_service(&config, handler, &cancelled).await?;
        let peer = service.peer().clone();
        let revisions = service.service().state.revisions();
        let discovered = cancellable(
            config.timeout(),
            "MCP discovery",
            &cancelled,
            discover(&peer, &config),
        )
        .await;
        match discovered {
            Ok(discovered) => Ok((service, peer, transport, discovered, revisions)),
            Err(error) => {
                let error = with_stderr(error, stderr.as_ref());
                match close_service(&mut service).await {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(failed(format!("{error}; cleanup failed: {cleanup}"))),
                }
            }
        }
    }
    .await;
    let mut manager = lock(&state);
    let entry = manager
        .entries
        .get_mut(&id)
        .expect("serialized connection owns its entry");
    assert_eq!(entry.generation, generation);
    let result = match result {
        Ok((service, peer, transport, discovered, revisions)) => {
            entry.service = Some(service);
            entry.peer = Some(peer.clone());
            entry.connection_transport = Some(transport);
            entry.state = ConnectionState::Connected;
            entry.tools = discovered.0;
            entry.resources = discovered.1;
            entry.templates = discovered.2;
            entry.prompts = discovered.3;
            entry.skipped_output_tools = discovered.4;
            entry.instructions = peer.peer_info().and_then(|info| info.instructions.clone());
            (
                entry.seen_tool_revision,
                entry.seen_resource_revision,
                entry.seen_prompt_revision,
            ) = revisions;
            Ok(())
        }
        Err(error) => {
            entry.state = ConnectionState::Failed;
            entry.error = Some(error.to_string());
            if cancelled.load(Ordering::Relaxed) {
                Err(error)
            } else {
                Ok(())
            }
        }
    };
    manager.tool_revision += 1;
    result
}

pub(super) async fn refresh_entry(
    state: Arc<Mutex<ManagerState>>,
    id: String,
    cancelled: Arc<AtomicBool>,
) -> io::Result<()> {
    let (duration, closed) = {
        let manager = lock(&state);
        let Some(entry) = manager.entries.get(&id) else {
            return Ok(());
        };
        (
            entry.config.timeout(),
            entry.peer.as_ref().is_some_and(Peer::is_transport_closed),
        )
    };
    if closed {
        let (service, calls) = {
            let mut manager = lock(&state);
            let entry = manager
                .entries
                .get_mut(&id)
                .expect("serialized refresh owns its entry");
            entry.clear_catalogs();
            entry.state = ConnectionState::Failed;
            entry.error = Some("MCP connection closed; reconnect to retry".into());
            let values = (entry.service.take(), std::mem::take(&mut entry.calls));
            manager.tool_revision += 1;
            values
        };
        return stop_connection(service, calls).await;
    }
    let result = cancellable(
        duration,
        "MCP catalog refresh",
        &cancelled,
        refresh_catalogs(state.clone(), id.clone()),
    )
    .await;
    if let Err(error) = &result
        && let Some(entry) = lock(&state).entries.get_mut(&id)
    {
        entry.error = Some(format!("catalog refresh: {error}"));
    }
    result
}

async fn refresh_catalogs(state: Arc<Mutex<ManagerState>>, id: String) -> io::Result<()> {
    let (peer, config, generation, revisions, changed) = {
        let manager = lock(&state);
        let Some(entry) = manager.entries.get(&id) else {
            return Ok(());
        };
        if entry.state != ConnectionState::Connected {
            return Ok(());
        }
        let Some(peer) = entry.peer.clone() else {
            return Ok(());
        };
        let revisions = entry.handler.revisions();
        (
            peer,
            entry.config.clone(),
            entry.generation,
            revisions,
            (
                revisions.0 != entry.seen_tool_revision,
                revisions.1 != entry.seen_resource_revision,
                revisions.2 != entry.seen_prompt_revision,
            ),
        )
    };
    if !changed.0 && !changed.1 && !changed.2 {
        return Ok(());
    }
    let tools = if changed.0 {
        Some(tool_records(
            config.id(),
            list_tools(&peer, config.timeout()).await?,
        )?)
    } else {
        None
    };
    let resources = if changed.1 {
        Some((
            json_values(&list_resources(&peer, config.timeout()).await?)?,
            json_values(&list_templates(&peer, config.timeout()).await?)?,
        ))
    } else {
        None
    };
    let prompts = if changed.2 {
        Some(json_values(&list_prompts(&peer, config.timeout()).await?)?)
    } else {
        None
    };
    let mut manager = lock(&state);
    let Some(entry) = manager.entries.get_mut(&id) else {
        return Ok(());
    };
    if entry.generation != generation || entry.state != ConnectionState::Connected {
        return Ok(());
    }
    let tools_changed = tools.is_some();
    if let Some((tools, skipped_output)) = tools {
        entry.tools = tools;
        entry.skipped_output_tools = skipped_output;
        entry.seen_tool_revision = revisions.0;
    }
    if let Some((resources, templates)) = resources {
        entry.resources = resources;
        entry.templates = templates;
        entry.seen_resource_revision = revisions.1;
    }
    if let Some(prompts) = prompts {
        entry.prompts = prompts;
        entry.seen_prompt_revision = revisions.2;
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
) -> io::Result<(Peer<RoleClient>, Duration)> {
    let manager = lock(state);
    let entry = manager
        .entries
        .get(server)
        .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
    if entry.state != ConnectionState::Connected {
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

pub(super) async fn remove_entry(state: Arc<Mutex<ManagerState>>, server: &str) -> io::Result<()> {
    let entry = {
        let mut manager = lock(&state);
        if manager.closing {
            return Err(failed("MCP manager is shutting down"));
        }
        let entry = manager
            .entries
            .remove(server)
            .ok_or_else(|| failed(format!("unknown MCP server: {server}")))?;
        manager.order.retain(|id| id != server);
        manager.tool_revision += 1;
        entry
    };
    stop_connection(entry.service, entry.calls).await
}

pub(super) async fn close_all(state: Arc<Mutex<ManagerState>>) -> io::Result<()> {
    let ids = {
        let mut manager = lock(&state);
        manager.closing = true;
        manager.order.clone()
    };
    close_entries(state, &ids).await
}

pub(super) async fn close_entries(
    state: Arc<Mutex<ManagerState>>,
    ids: &[String],
) -> io::Result<()> {
    let services = {
        let mut manager = lock(&state);
        let services = manager
            .entries
            .values_mut()
            .filter(|entry| ids.iter().any(|id| id == entry.config.id()))
            .map(|entry| {
                let service = entry.service.take();
                let calls = std::mem::take(&mut entry.calls);
                entry.clear_catalogs();
                entry.state = if entry.config.enabled() {
                    ConnectionState::Idle
                } else {
                    ConnectionState::Disabled
                };
                (entry.config.id().to_owned(), service, calls)
            })
            .collect::<Vec<_>>();
        manager.tool_revision += 1;
        services
    };
    let failures = futures_util::future::join_all(services.into_iter().map(
        |(id, service, calls)| async move {
            stop_connection(service, calls)
                .await
                .map_err(|error| format!("{id}: {error}"))
        },
    ))
    .await
    .into_iter()
    .filter_map(Result::err)
    .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failed(failures.join("; ")))
    }
}

async fn stop_connection(
    service: Option<RunningService<RoleClient, Handler>>,
    calls: Vec<call::OwnedCall>,
) -> io::Result<()> {
    for call in &calls {
        call.shared.cancelled.store(true, Ordering::Relaxed);
    }
    let close = async {
        if let Some(mut service) = service {
            close_service(&mut service).await
        } else {
            Ok(())
        }
    };
    let drain = async {
        let mut failures = Vec::new();
        for mut call in calls {
            match tokio::time::timeout(Duration::from_secs(2), &mut call.task).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(format!("MCP call task: {error}")),
                Err(_) => {
                    call.task.abort();
                    if let Err(error) = call.task.await
                        && !error.is_cancelled()
                    {
                        failures.push(error.to_string());
                    }
                    failures.push("MCP call cleanup timed out".into());
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failed(failures.join("; ")))
        }
    };
    let (close, drain) = tokio::join!(close, drain);
    match (close, drain) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(left), Err(right)) => Err(failed(format!("{left}; {right}"))),
    }
}
