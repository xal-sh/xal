mod models;
mod responses;

pub use models::{context_window, default_model, default_thinking};

use std::sync::Arc;

use futures_util::StreamExt;
use reqwest13::Client;
use xal_host::*;
use xal_services::transport;

pub struct OpenAi {
    client: Client,
    key: Arc<String>,
    base_url: String,
    model: String,
}

impl OpenAi {
    pub fn new(key: String, model: String, base_url: String) -> Result<Self> {
        let url = reqwest13::Url::parse(&base_url)
            .map_err(|_| Error::Failed("invalid OpenAI endpoint".into()))?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Failed(
                "OpenAI endpoint cannot contain credentials, a query, or a fragment".into(),
            ));
        }
        if url.scheme() != "https"
            && !(url.scheme() == "http"
                && url
                    .host_str()
                    .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]"].contains(&host)))
        {
            return Err(Error::Failed(
                "OpenAI endpoint requires HTTPS (HTTP is only allowed for loopback fixtures)"
                    .into(),
            ));
        }
        Ok(Self {
            client: transport::client().map_err(|error| Error::Failed(error.to_string()))?,
            key: Arc::new(key),
            base_url: base_url.trim_end_matches('/').into(),
            model,
        })
    }
}

impl Plugin for OpenAi {
    fn name(&self) -> &str {
        "openai"
    }

    fn register(&mut self, registration: &mut Registration) -> Result<()> {
        let client = self.client.clone();
        let key = self.key.clone();
        let endpoint = format!("{}/responses", self.base_url);
        registration.provider(
            "openai",
            Provider {
                models: vec![self.model.clone()],
                stream: Box::new(move |request, context, sender| {
                    let client = client.clone();
                    let key = key.clone();
                    let endpoint = endpoint.clone();
                    Box::pin(async move {
                        context.cancellation.check()?;
                        let response = client
                            .post(endpoint)
                            .bearer_auth(key.as_str())
                            .header("accept", "text/event-stream")
                            .header(
                                "x-client-request-id",
                                xal_services::credentials::new_id()
                                    .map_err(|error| Error::Failed(error.to_string()))?,
                            )
                            .json(&responses::body(&request)?)
                            .send()
                            .await
                            .map_err(|error| {
                                provider_error(format!("OpenAI request failed: {error}"), true)
                            })?;
                        if !response.status().is_success() {
                            let status = response.status().as_u16();
                            let retry_after_ms = response
                                .headers()
                                .get("retry-after")
                                .and_then(|value| value.to_str().ok())
                                .and_then(|value| value.parse::<f64>().ok())
                                .filter(|value| value.is_finite() && *value >= 0.0)
                                .map(|value| (value.min(120.0) * 1000.0).round() as u64);
                            let mut bytes = Vec::new();
                            let mut stream = response.bytes_stream();
                            while bytes.len() < 64 * 1024 {
                                let Some(chunk) = stream.next().await else {
                                    break;
                                };
                                let chunk = chunk
                                    .map_err(|error| provider_error(error.to_string(), true))?;
                                bytes.extend_from_slice(
                                    &chunk[..chunk.len().min(64 * 1024 - bytes.len())],
                                );
                            }
                            let detail = serde_json::from_slice::<serde_json::Value>(&bytes)
                                .ok()
                                .and_then(|value| {
                                    value
                                        .get("error")
                                        .and_then(|value| value.get("message"))
                                        .and_then(|value| value.as_str())
                                        .map(str::to_owned)
                                });
                            return Err(Error::Provider {
                                message: if status == 401 {
                                    "OpenAI API authentication failed; reconnect the provider"
                                        .into()
                                } else {
                                    format!(
                                        "OpenAI request failed ({status}): {}",
                                        detail.unwrap_or_else(|| "HTTP error".into())
                                    )
                                },
                                retryable: [408, 409, 429].contains(&status) || status >= 500,
                                retry_after_ms,
                            });
                        }
                        let mut stream = transport::Sse::new(response);
                        while let Some(data) = stream.next().await.map_err(|error| {
                            provider_error(format!("OpenAI stream failed: {error}"), true)
                        })? {
                            let Some(event) = responses::event(&data, &request.model)? else {
                                continue;
                            };
                            let terminal = matches!(event, ProviderEvent::Done { .. });
                            sender.send(event).await?;
                            if terminal {
                                return Ok(());
                            }
                        }
                        Err(provider_error(
                            "OpenAI stream ended unexpectedly".into(),
                            true,
                        ))
                    })
                }),
            },
        )
    }
}

fn provider_error(message: String, retryable: bool) -> Error {
    Error::Provider {
        message,
        retryable,
        retry_after_ms: None,
    }
}
