use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRequest {
    pub server: String,
    pub uri: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PromptRequest {
    pub server: String,
    pub name: String,
    pub arguments: Option<std::collections::BTreeMap<String, String>>,
}

impl McpManager {
    pub async fn connect_all(&self, cancelled: Arc<AtomicBool>) -> io::Result<()> {
        self.reconnect(None, cancelled).await
    }

    pub async fn reconnect(
        &self,
        server: Option<&str>,
        cancelled: Arc<AtomicBool>,
    ) -> io::Result<()> {
        let _operation = self.lock_operation(&cancelled).await?;
        let ids = if let Some(server) = server {
            vec![server.to_owned()]
        } else {
            let manager = lock(&self.state);
            manager
                .order
                .iter()
                .filter(|id| {
                    manager
                        .entries
                        .get(*id)
                        .is_some_and(|entry| entry.config.enabled())
                })
                .cloned()
                .collect()
        };
        let results = if cancelled.load(Ordering::Relaxed) {
            Vec::new()
        } else {
            futures_util::future::join_all(
                ids.iter()
                    .map(|id| connect_entry(self.state.clone(), id.clone(), cancelled.clone())),
            )
            .await
        };
        if cancelled.load(Ordering::Relaxed) {
            let mut failures = results
                .into_iter()
                .filter_map(Result::err)
                .filter(|error| error.kind() != io::ErrorKind::Interrupted)
                .map(|error| error.to_string())
                .collect::<Vec<_>>();
            if let Err(error) = lifecycle::close_entries(self.state.clone(), &ids).await {
                failures.push(format!("cleanup failed: {error}"));
            }
            return Err(if failures.is_empty() {
                Error::new(io::ErrorKind::Interrupted, "MCP connection was cancelled")
            } else {
                failed(format!(
                    "MCP connection was cancelled; {}",
                    failures.join("; ")
                ))
            });
        }
        for result in results {
            result?;
        }
        Ok(())
    }

    pub async fn remove(&self, server: &str) -> io::Result<()> {
        let _operation = self.operation.lock().await;
        remove_entry(self.state.clone(), server).await
    }

    pub async fn refresh(&self, cancelled: Arc<AtomicBool>) -> io::Result<()> {
        let _operation = self.lock_operation(&cancelled).await?;
        self.collect_calls().await?;
        let ids = lock(&self.state).order.clone();
        let mut failures = Vec::new();
        for result in futures_util::future::join_all(
            ids.into_iter()
                .map(|id| refresh_entry(self.state.clone(), id, cancelled.clone())),
        )
        .await
        {
            if let Err(error) = result {
                failures.push(error.to_string());
            }
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(
                io::ErrorKind::Interrupted,
                "MCP refresh was cancelled",
            ));
        }
        if failures.is_empty() {
            return Ok(());
        }
        Err(failed(failures.join("; ")))
    }

    async fn lock_operation(
        &self,
        cancelled: &Arc<AtomicBool>,
    ) -> io::Result<tokio::sync::MutexGuard<'_, ()>> {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    io::ErrorKind::Interrupted,
                    "MCP operation was cancelled",
                ));
            }
            tokio::select! {
                guard = self.operation.lock() => {
                    let mut manager = lock(&self.state);
                    if manager.closing { return Err(failed("MCP manager is shutting down")); }
                    manager.operation_cancel = Some(cancelled.clone());
                    return Ok(guard);
                },
                () = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }
    }

    async fn collect_calls(&self) -> io::Result<()> {
        let completed = {
            let mut state = lock(&self.state);
            let mut completed = Vec::new();
            for entry in state.entries.values_mut() {
                let mut pending = Vec::new();
                for call in std::mem::take(&mut entry.calls) {
                    if call.task.is_finished() {
                        completed.push(call.task);
                    } else {
                        pending.push(call);
                    }
                }
                entry.calls = pending;
            }
            completed
        };
        for task in completed {
            task.await
                .map_err(|error| failed(format!("MCP call task: {error}")))?;
        }
        Ok(())
    }

    pub async fn close(&self) -> io::Result<()> {
        {
            let mut manager = lock(&self.state);
            manager.closing = true;
            if let Some(cancelled) = &manager.operation_cancel {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
        let _operation = self.operation.lock().await;
        close_all(self.state.clone()).await
    }

    pub async fn read_resource(
        &self,
        request: ResourceRequest,
        cancelled: &AtomicBool,
    ) -> io::Result<String> {
        if request.server.is_empty() || request.uri.is_empty() {
            return Err(invalid("server and uri are required"));
        }
        let (peer, duration) = connected_peer(&self.state, &request.server, "resources")?;
        let handle = cancellable(
            duration,
            "MCP resource request",
            cancelled,
            peer.send_cancellable_request(
                ClientRequest::ReadResourceRequest(rmcp::model::ReadResourceRequest::new(
                    ReadResourceRequestParams::new(request.uri),
                )),
                PeerRequestOptions::no_options(),
            ),
        )
        .await?;
        let ServerResult::ReadResourceResult(result) =
            await_response(handle, duration, cancelled, "MCP resource read").await?
        else {
            return Err(failed("MCP resource read returned an unexpected response"));
        };
        let value = serde_json::to_value(result).map_err(|error| failed(error.to_string()))?;
        let mut sections = value
            .get("contents")
            .and_then(Value::as_array)
            .ok_or_else(|| failed("MCP resource result is malformed"))?
            .iter()
            .map(format_resource)
            .collect::<io::Result<Vec<_>>>()?;
        sections.retain(|section| !section.is_empty());
        Ok(if sections.is_empty() {
            "(empty MCP resource)".into()
        } else {
            sections.join("\n\n")
        })
    }

    pub async fn get_prompt(
        &self,
        request: PromptRequest,
        cancelled: &AtomicBool,
    ) -> io::Result<String> {
        if request.server.is_empty() || request.name.is_empty() {
            return Err(invalid("server and name are required"));
        }
        let (peer, duration) = connected_peer(&self.state, &request.server, "prompts")?;
        let mut params = rmcp::model::GetPromptRequestParams::new(request.name);
        params.arguments = request.arguments.map(|arguments| {
            arguments
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect()
        });
        let handle = cancellable(
            duration,
            "MCP prompt request",
            cancelled,
            peer.send_cancellable_request(
                ClientRequest::GetPromptRequest(rmcp::model::GetPromptRequest::new(params)),
                PeerRequestOptions::no_options(),
            ),
        )
        .await?;
        let ServerResult::GetPromptResult(result) =
            await_response(handle, duration, cancelled, "MCP prompt request").await?
        else {
            return Err(failed("MCP prompt request returned an unexpected response"));
        };
        format_prompt(&serde_json::to_value(result).map_err(|error| failed(error.to_string()))?)
    }
}
