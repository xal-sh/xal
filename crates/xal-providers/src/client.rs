use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest13::{Response, Url};
use serde_json::Value;
use xal_host::*;
use xal_services::{
    credentials::{Credential, Credentials},
    redactor::Redactor,
    settings::Settings,
    transport,
};

use crate::{Id, Protocol, catalog::Model, failure, invalid, provider_error};

#[derive(Clone)]
pub enum Account {
    Fixed(Credential),
    Profile { home: PathBuf, id: String },
}
#[derive(Clone)]
pub struct Client {
    pub id: Id,
    pub endpoint: String,
    pub domain: String,
    pub auth_endpoint: Option<String>,
    pub context_cap: u64,
    pub client_name: String,
    pub redactor: Arc<Redactor>,
    pub(crate) account: Account,
    pub(crate) http: reqwest13::Client,
    pub(crate) refresh: Arc<crate::profiles::Refresh>,
    interaction: String,
}

pub fn endpoint(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| invalid("invalid provider endpoint"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid(
            "provider endpoint cannot contain credentials, a query, or a fragment",
        ));
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| ["localhost", "127.0.0.1", "[::1]"].contains(&h)))
    {
        return Err(invalid(
            "provider endpoint requires HTTPS (HTTP is only allowed for loopback fixtures)",
        ));
    }
    Ok(value.trim_end_matches('/').into())
}
impl Client {
    pub fn new(
        id: Id,
        account: Account,
        settings: &Settings,
        redactor: Arc<Redactor>,
    ) -> Result<Self> {
        let config = settings.plugin_config.get(id.plugin());
        let allowed: &[&str] = match id {
            Id::OpenAi | Id::ChatGpt => &["contextWindow", "clientName"],
            Id::Xai | Id::Alibaba => &["baseUrl", "clientName"],
            Id::Copilot => &["enterpriseDomain", "clientName"],
            Id::TypeSafe => &[],
            _ => &["clientName"],
        };
        if let Some(config) = config
            && config.keys().any(|k| !allowed.contains(&k.as_str()))
        {
            return Err(invalid(&format!(
                "unknown {} provider configuration option",
                id.plugin()
            )));
        }
        let text = |key: &str, default: &str| -> Result<String> {
            match config.and_then(|c| c.get(key)) {
                None => Ok(default.into()),
                Some(v) => v
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().into())
                    .ok_or_else(|| {
                        invalid(&format!(
                            "{}.{} must be a non-empty string",
                            id.plugin(),
                            key
                        ))
                    }),
            }
        };
        let mut domain = text("enterpriseDomain", "github.com")?;
        if id == Id::Copilot {
            let url = Url::parse(&if domain.contains("://") {
                domain.clone()
            } else {
                format!("https://{domain}")
            })
            .map_err(|_| invalid("invalid GitHub domain"))?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.port().is_some()
                || url.path() != "/"
            {
                return Err(invalid("invalid GitHub Enterprise domain"));
            }
            domain = url
                .host_str()
                .ok_or_else(|| invalid("invalid GitHub domain"))?
                .into();
        }
        let base = if id == Id::Copilot && domain != "github.com" {
            format!("https://copilot-api.{domain}")
        } else {
            text("baseUrl", id.endpoint())?
        };
        let cap = match config.and_then(|c| c.get("contextWindow")) {
            None => 260_000,
            Some(v) => v
                .as_u64()
                .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                .ok_or_else(|| invalid("openai.contextWindow must be a positive integer"))?,
        };
        let refresh = match &account {
            Account::Profile { home, id: profile } => crate::profiles::refresh(home, id, profile)?,
            Account::Fixed(_) => Arc::new(crate::profiles::Refresh::new(None)),
        };
        Ok(Self {
            id,
            endpoint: endpoint(&base)?,
            domain,
            auth_endpoint: None,
            context_cap: cap,
            client_name: text(
                "clientName",
                if matches!(id, Id::OpenAi | Id::ChatGpt) {
                    "codex_cli_rs"
                } else {
                    "xal"
                },
            )?,
            redactor,
            account,
            http: transport::client().map_err(failure)?,
            refresh,
            interaction: xal_services::credentials::new_id().map_err(failure)?,
        })
    }
    pub fn profile(&self) -> Option<&str> {
        match &self.account {
            Account::Profile { id, .. } => Some(id),
            Account::Fixed(_) => None,
        }
    }
    pub(crate) fn load(&self) -> Result<Credential> {
        let credential = match &self.account {
            Account::Fixed(c) => c.clone(),
            Account::Profile { home, id } => Credentials::load(&home.join("credentials.json"))
                .map_err(failure)?
                .credential(self.id.as_str(), id)
                .map_err(failure)?
                .cloned()
                .ok_or_else(|| invalid("profile is no longer connected; reconnect the provider"))?,
        };
        if matches!(credential, Credential::OAuth { .. })
            && !matches!(self.id, Id::ChatGpt | Id::Xai)
        {
            return Err(invalid("provider requires an API-key credential"));
        }
        if self.id == Id::ChatGpt
            && !matches!(
                &credential,
                Credential::OAuth {
                    account_id: Some(_),
                    ..
                }
            )
        {
            return Err(invalid(
                "ChatGPT requires an OAuth account with an account ID",
            ));
        }
        self.redactor
            .protect(credential.secrets())
            .map_err(failure)?;
        Ok(credential)
    }
    pub async fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        request: Option<&ProviderRequest>,
        cancel: &Cancellation,
    ) -> Result<Response> {
        self.request_bound(path, body, request, cancel, &mut None)
            .await
    }
    pub(crate) async fn request_bound(
        &self,
        path: &str,
        body: Option<&Value>,
        request: Option<&ProviderRequest>,
        cancel: &Cancellation,
        used: &mut Option<Credential>,
    ) -> Result<Response> {
        let operation = async {
            for attempt in 0..2 {
                let credential = self.credential(attempt != 0, cancel).await?;
                *used = Some(credential.clone());
                let token = match &credential {
                    Credential::ApiKey { key } => key,
                    Credential::OAuth { access, .. } => access,
                };
                let mut call = if body.is_some() {
                    self.http.post(format!("{}{path}", self.endpoint))
                } else {
                    self.http
                        .get(format!("{}{path}", self.endpoint))
                        .timeout(Duration::from_secs(15))
                };
                call = call
                    .header(
                        "user-agent",
                        format!("{}/{}", self.client_name, env!("CARGO_PKG_VERSION")),
                    )
                    .header(
                        "accept",
                        if request.is_some() {
                            "text/event-stream"
                        } else {
                            "application/json"
                        },
                    );
                match self.id {
                    Id::Anthropic | Id::MiniMax | Id::MiniMaxPlan => {
                        call = call
                            .header("x-api-key", token)
                            .header("anthropic-version", "2023-06-01");
                    }
                    Id::OpenRouter => {
                        call = call.bearer_auth(token).header("x-title", "xal");
                    }
                    Id::Google => {
                        call = call.header("x-goog-api-key", token);
                    }
                    Id::ChatGpt => {
                        let Credential::OAuth {
                            account_id: Some(account),
                            ..
                        } = &credential
                        else {
                            return Err(invalid("missing ChatGPT account ID"));
                        };
                        call = call
                            .bearer_auth(token)
                            .header("chatgpt-account-id", account)
                            .header("originator", &self.client_name);
                        if let Some(request) = request {
                            call = call
                                .header("openai-beta", "responses=experimental")
                                .header("session-id", &request.session_id);
                        }
                    }
                    Id::Copilot => {
                        call = call
                            .bearer_auth(token)
                            .header("copilot-integration-id", "copilot-developer-cli")
                            .header("x-github-api-version", "2025-05-01")
                            .header("x-interaction-id", &self.interaction)
                            .header(
                                "openai-intent",
                                if request.is_some() {
                                    "conversation-edits"
                                } else {
                                    "conversation-agent"
                                },
                            );
                        let agent = request.is_some_and(|r| {
                            r.input
                                .last()
                                .is_some_and(|i| !matches!(i, Item::UserMessage { .. }))
                        });
                        call = call.header("x-initiator", if agent { "agent" } else { "user" });
                        if request.is_some_and(|r| {
                            r.input.iter().any(
                                |i| matches!(i,Item::UserMessage{images,..} if !images.is_empty()),
                            )
                        }) {
                            call = call.header("copilot-vision-request", "true");
                        }
                    }
                    _ => {
                        call = call.bearer_auth(token);
                    }
                }
                if let Some(request) = request {
                    call = call.header(
                        "x-client-request-id",
                        xal_services::credentials::new_id().map_err(failure)?,
                    );
                    if self.id == Id::Go {
                        call = call.header("x-opencode-session", &request.session_id);
                    }
                    if self.id == Id::Xai {
                        call = call.header("x-grok-conv-id", &request.session_id);
                    }
                }
                if let Some(body) = body {
                    call = call.json(body);
                }
                let response = call.send().await.map_err(|_| {
                    provider_error(format!("{} request failed", self.id.as_str()), true)
                })?;
                if response.status().as_u16() == 401
                    && attempt == 0
                    && matches!(credential, Credential::OAuth { .. })
                {
                    continue;
                }
                return checked(self.id, response, &self.redactor).await;
            }
            Err(invalid("authentication retry exhausted"))
        };
        let result = tokio::select! {biased;()=cancel.cancelled()=>Err(Error::Cancelled),result=operation=>result};
        self.settle_refresh().await?;
        result
    }
    pub fn body(&self, model: &Model, request: &ProviderRequest) -> Result<Value> {
        if request
            .input
            .iter()
            .any(|i| matches!(i,Item::UserMessage{images,..} if !images.is_empty()))
            && !model.input_modalities.iter().any(|m| m == "image")
        {
            return Err(invalid("selected model does not support image input"));
        }
        match model.protocol(self.id)? {
            Protocol::Responses => crate::responses::body(self.id, request),
            Protocol::Chat => crate::chat::body(self.id, request),
            Protocol::Messages => crate::messages::body(self.id, model, request),
            Protocol::Gemini => crate::gemini::body(request),
        }
    }
    pub async fn stream(
        &self,
        model: &Model,
        request: ProviderRequest,
        cancel: &Cancellation,
        sender: Sender<ProviderEvent>,
    ) -> Result<()> {
        let operation = async {
            if let (Some(bound), Some(selected)) = (self.profile(), request.profile.as_deref())
                && bound != selected
            {
                return Err(invalid("provider request belongs to another profile"));
            }
            let protocol = model.protocol(self.id)?;
            let path = match protocol {
                Protocol::Responses => "/responses".into(),
                Protocol::Chat => "/chat/completions".into(),
                Protocol::Messages => "/messages".into(),
                Protocol::Gemini => format!(
                    "/models/{}:streamGenerateContent?alt=sse",
                    crate::catalog::encoded(&request.model)
                ),
            };
            let response = self
                .request(
                    &path,
                    Some(&self.body(model, &request)?),
                    Some(&request),
                    cancel,
                )
                .await?;
            let mut stream = transport::Sse::new(response);
            let mut chat = crate::chat::Decoder::default();
            let mut messages = crate::messages::Decoder::default();
            let mut gemini = crate::gemini::Decoder::default();
            let mut usage = None;
            let mut bytes = 0usize;
            while let Some(data) = stream
                .next()
                .await
                .map_err(|_| provider_error(format!("{} stream failed", self.id.as_str()), true))?
            {
                bytes = bytes.saturating_add(data.len());
                if bytes > 32 * 1024 * 1024 {
                    return Err(invalid("provider stream exceeds 32 MiB"));
                }
                let result = match protocol {
                    Protocol::Responses => {
                        if let Ok(raw) = serde_json::from_str::<Value>(&data)
                            && let Some(u) = raw.pointer("/response/usage").filter(|u| !u.is_null())
                        {
                            usage = Some(Usage {
                                total_input_tokens: crate::count(u.get("input_tokens"))?,
                                output_tokens: crate::count(u.get("output_tokens"))?,
                                cache_read_input_tokens: crate::count(
                                    u.pointer("/input_tokens_details/cached_tokens"),
                                )?,
                                cache_write_input_tokens: crate::count(
                                    u.pointer("/input_tokens_details/cache_write_tokens"),
                                )?,
                            });
                        }
                        crate::responses::event(self.id, &data, &request.model)
                            .map(|e| e.into_iter().collect::<Vec<_>>())
                    }
                    Protocol::Chat => chat.push(self.id, &request.model, &data),
                    Protocol::Messages => messages.push(self.id, &request.model, &data),
                    Protocol::Gemini => gemini.push(&request.model, &data),
                };
                let latest = match protocol {
                    Protocol::Responses => usage.clone(),
                    Protocol::Chat => chat.usage.clone(),
                    Protocol::Messages => messages.usage.clone(),
                    Protocol::Gemini => gemini.usage.clone(),
                };
                if let Some(latest) = latest {
                    sender.send(ProviderEvent::Usage(latest)).await?;
                }
                for event in result? {
                    let done = matches!(event, ProviderEvent::Done { .. });
                    sender.send(event).await?;
                    if done {
                        return Ok(());
                    }
                }
            }
            if protocol == Protocol::Gemini {
                for event in gemini.finish(&request.model)? {
                    sender.send(event).await?;
                }
                return Ok(());
            }
            Err(provider_error(
                format!("{} stream ended unexpectedly", self.id.as_str()),
                true,
            ))
        };
        tokio::select! {biased;()=cancel.cancelled()=>Err(Error::Cancelled),result=operation=>result}
    }
}
pub(crate) async fn checked(id: Id, response: Response, redactor: &Redactor) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let retry_after_ms = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| transport::retry_after(v, std::time::SystemTime::now()));
    let raw = transport::json(response, 64 * 1024).await;
    let detail = match raw {
        Ok(value) => value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(|s| redactor.redact(s)),
        Err(error) => Some(format!("could not read error response: {error}")),
    };
    let message = match status {
        401 => format!(
            "{} authentication failed; reconnect the provider",
            id.as_str()
        ),
        402 => format!("{} balance or usage limits exhausted", id.as_str()),
        _ => format!(
            "{} request failed ({status}): {}",
            id.as_str(),
            detail.unwrap_or_else(|| "HTTP error".into())
        ),
    };
    Err(Error::Provider {
        message,
        retryable: [408, 409, 429].contains(&status) || status >= 500,
        retry_after_ms,
    })
}
