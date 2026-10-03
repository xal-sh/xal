use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest13::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use xal_host::*;
use xal_services::{
    credentials::{Change, Credential},
    transport,
};

use crate::{
    Id,
    client::{Account, Client},
    failure, invalid, string,
};

fn now() -> Result<f64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(failure)?
        .as_secs_f64()
        * 1000.0)
}
fn issuer(id: Id, domain: &str) -> Result<String> {
    match id {
        Id::ChatGpt => Ok("https://auth.openai.com".into()),
        Id::Xai => Ok("https://auth.x.ai".into()),
        Id::Copilot => Ok(format!("https://{domain}")),
        _ => Err(invalid("provider has no OAuth flow")),
    }
}
fn client_id(id: Id) -> Result<&'static str> {
    match id {
        Id::ChatGpt => Ok("app_EMoamEEZ73f0CkXaXp7hrann"),
        Id::Xai => Ok("b1a00492-073a-47ea-816f-4c329264a828"),
        Id::Copilot => Ok("Ov23liczUGMpBbj2dzAn"),
        _ => Err(invalid("provider has no OAuth client")),
    }
}
fn token_path(id: Id) -> Result<&'static str> {
    match id {
        Id::ChatGpt => Ok("/oauth/token"),
        Id::Xai => Ok("/oauth2/token"),
        Id::Copilot => Ok("/login/oauth/access_token"),
        _ => Err(invalid("provider has no token endpoint")),
    }
}
fn claim(token: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let raw: Value = serde_json::from_slice(&bytes).ok()?;
    raw.get("chatgpt_account_id")
        .or_else(|| raw.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
        .or_else(|| raw.pointer("/organizations/0/id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub fn credential(
    id: Id,
    raw: &Value,
    previous: Option<&Credential>,
    time: f64,
) -> Result<Credential> {
    let access = string(raw, "access_token")?.to_owned();
    if access.is_empty() {
        return Err(invalid("token response has no access token"));
    }
    if id == Id::Copilot {
        return Ok(Credential::ApiKey { key: access });
    }
    let (old_refresh, old_account) = match previous {
        Some(Credential::OAuth {
            refresh,
            account_id,
            ..
        }) => (Some(refresh.as_str()), account_id.clone()),
        _ => (None, None),
    };
    let refresh = raw
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or(old_refresh)
        .ok_or_else(|| invalid("token response has no refresh token"))?
        .into();
    let lifetime = raw
        .get("expires_in")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(3600.0);
    let account_id = if id == Id::ChatGpt {
        Some(
            raw.get("id_token")
                .and_then(Value::as_str)
                .and_then(claim)
                .or_else(|| claim(&access))
                .or(old_account)
                .ok_or_else(|| {
                    invalid("token carries no ChatGPT account ID; reconnect with a ChatGPT plan")
                })?,
        )
    } else {
        None
    };
    let expires = time + lifetime * 1000.0 - if id == Id::Xai { 300_000.0 } else { 0.0 };
    if !expires.is_finite() {
        return Err(invalid("invalid token expiry"));
    }
    Ok(Credential::OAuth {
        access,
        refresh,
        expires,
        account_id,
    })
}
impl Client {
    async fn auth_post(
        &self,
        path: &str,
        fields: Value,
        form: bool,
        cancel: &Cancellation,
    ) -> Result<(u16, Value)> {
        let operation = async {
            let call = self
                .http
                .post(format!(
                    "{}{path}",
                    self.auth_endpoint
                        .clone()
                        .map(|value| crate::client::endpoint(&value))
                        .unwrap_or_else(|| issuer(self.id, &self.domain))?
                ))
                .header("accept", "application/json")
                .header(
                    "user-agent",
                    format!("{}/{}", self.client_name, env!("CARGO_PKG_VERSION")),
                )
                .timeout(Duration::from_secs(30));
            let call = if form {
                call.form(&fields)
            } else {
                call.json(&fields)
            };
            let response = call
                .send()
                .await
                .map_err(|_| invalid("OAuth request failed"))?;
            let status = response.status().as_u16();
            if self.id == Id::ChatGpt
                && path == "/api/accounts/deviceauth/token"
                && [403, 404].contains(&status)
            {
                return Ok((status, Value::Null));
            }
            let raw = transport::json(response, 1024 * 1024)
                .await
                .map_err(|_| invalid("OAuth response was not valid bounded JSON"))?;
            for field in [
                "access_token",
                "refresh_token",
                "id_token",
                "authorization_code",
                "code_verifier",
                "device_code",
                "device_auth_id",
            ] {
                if let Some(v) = raw.get(field).and_then(Value::as_str) {
                    self.redactor.protect(vec![v.into()]).map_err(failure)?;
                }
            }
            Ok((status, raw))
        };
        tokio::select! {biased;()=cancel.cancelled()=>Err(Error::Cancelled),result=operation=>result}
    }
    pub async fn credential(&self, force: bool, cancel: &Cancellation) -> Result<Credential> {
        cancel.check()?;
        let source = self.load()?;
        let Credential::OAuth { expires, .. } = &source else {
            return Ok(source);
        };
        let skew = if self.id == Id::ChatGpt {
            60_000.0
        } else {
            0.0
        };
        if !force && expires - skew > now()? {
            return Ok(source);
        }
        let mut operation = tokio::select! { biased; ()=cancel.cancelled()=>return Err(Error::Cancelled),guard=self.refresh.lock()=>guard };
        if let Some(task) = operation.as_mut() {
            let result = task.await.map_err(failure)?;
            *operation = None;
            result?;
        }
        let current = self.load()?;
        if current != source {
            return Ok(current);
        }
        let client = self.clone();
        *operation = Some(tokio::spawn(async move { client.rotate(source).await }));
        let result = operation
            .as_mut()
            .ok_or_else(|| invalid("refresh task missing"))?
            .await
            .map_err(failure)?;
        *operation = None;
        result
    }
    pub async fn settle_refresh(&self) -> Result<()> {
        let mut operation = self.refresh.lock().await;
        if let Some(task) = operation.as_mut() {
            let result = task.await.map_err(failure)?;
            *operation = None;
            result?;
        }
        Ok(())
    }
    async fn rotate(&self, source: Credential) -> Result<Credential> {
        let Account::Profile { home, id } = &self.account else {
            return Err(invalid("OAuth refresh requires a stored profile"));
        };
        let Credential::OAuth { refresh, .. } = &source else {
            return Err(invalid("credential changed during refresh"));
        };
        let cancel = Cancellation::default();
        let (status, raw) = self.auth_post(token_path(self.id)?, json!({"grant_type":"refresh_token","client_id":client_id(self.id)?,"refresh_token":refresh}), true, &cancel).await?;
        if !(200..300).contains(&status) {
            return Err(invalid(&format!(
                "{} token refresh failed ({status}); reconnect the provider",
                self.id.as_str()
            )));
        }
        let next = credential(self.id, &raw, Some(&source), now()?)?;
        self.redactor.protect(next.secrets()).map_err(failure)?;
        crate::profiles::update(
            home,
            Change::Replace {
                provider: self.id.as_str().into(),
                id: id.clone(),
                expected: source,
                credential: next.clone(),
            },
            &cancel,
        )
        .await?;
        Ok(next)
    }
    pub async fn validate_key(&self, cancel: &Cancellation) -> Result<()> {
        if matches!(
            self.id,
            Id::Alibaba | Id::MiniMax | Id::MiniMaxPlan | Id::Go
        ) {
            self.load()?;
            return Ok(());
        }
        if self.id == Id::OpenRouter {
            self.request("/key", None, None, cancel).await?;
            return Ok(());
        }
        self.discover(cancel).await?;
        Ok(())
    }
    pub async fn device_start(&self, cancel: &Cancellation) -> Result<Device> {
        let (path, fields, form) = match self.id {
            Id::ChatGpt => (
                "/api/accounts/deviceauth/usercode",
                json!({"client_id":client_id(self.id)?}),
                false,
            ),
            Id::Xai => (
                "/oauth2/device/code",
                json!({"client_id":client_id(self.id)?,"scope":"openid profile email offline_access grok-cli:access api:access","referrer":self.client_name}),
                true,
            ),
            Id::Copilot => (
                "/login/device/code",
                json!({"client_id":client_id(self.id)?,"scope":"read:user"}),
                false,
            ),
            _ => return Err(invalid("provider does not support device login")),
        };
        let (status, raw) = self.auth_post(path, fields, form, cancel).await?;
        if !(200..300).contains(&status) {
            return Err(invalid(&format!("device authorization failed ({status})")));
        }
        Device::parse(self.id, &raw)
    }
    pub async fn device_finish(&self, device: Device, cancel: &Cancellation) -> Result<Credential> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(device.expires);
        let operation = async {
            let mut interval = device.interval;
            loop {
                if self.id != Id::ChatGpt {
                    tokio::time::sleep(Duration::from_secs_f64(
                        interval + if self.id == Id::Copilot { 3.0 } else { 0.0 },
                    ))
                    .await;
                }
                let fields = if self.id == Id::ChatGpt {
                    json!({"device_auth_id":device.code,"user_code":device.user_code})
                } else {
                    json!({"client_id":client_id(self.id)?,"device_code":device.code,"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})
                };
                let path = if self.id == Id::ChatGpt {
                    "/api/accounts/deviceauth/token"
                } else {
                    token_path(self.id)?
                };
                let (status, raw) = self
                    .auth_post(path, fields, self.id == Id::Xai, cancel)
                    .await?;
                if self.id == Id::ChatGpt {
                    if (200..300).contains(&status) {
                        return self
                            .exchange(
                                string(&raw, "authorization_code")?,
                                string(&raw, "code_verifier")?,
                                "https://auth.openai.com/deviceauth/callback",
                                cancel,
                            )
                            .await;
                    }
                    if ![403, 404].contains(&status) {
                        return Err(invalid(&format!("device authorization failed ({status})")));
                    }
                    tokio::time::sleep(Duration::from_secs_f64(interval + 3.0)).await;
                    continue;
                }
                if raw.get("access_token").and_then(Value::as_str).is_some()
                    && (200..300).contains(&status)
                {
                    let next = credential(self.id, &raw, None, now()?)?;
                    self.redactor.protect(next.secrets()).map_err(failure)?;
                    return Ok(next);
                }
                match raw.get("error").and_then(Value::as_str) {
                    Some("authorization_pending") => {}
                    Some("slow_down") => {
                        interval = raw
                            .get("interval")
                            .and_then(Value::as_f64)
                            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 3600.0)
                            .unwrap_or(interval + 5.0);
                    }
                    Some("access_denied" | "authorization_denied") => {
                        return Err(invalid("device authorization denied"));
                    }
                    Some("expired_token") => {
                        return Err(invalid("device code expired; start the connection again"));
                    }
                    _ => return Err(invalid(&format!("device login failed ({status})"))),
                }
            }
        };
        tokio::select! {biased;()=cancel.cancelled()=>Err(Error::Cancelled),result=tokio::time::timeout_at(deadline,operation)=>result.map_err(|_|invalid("device login timed out"))?}
    }
    pub fn browser_start(&self) -> Result<Browser> {
        if self.id != Id::ChatGpt {
            return Err(invalid("browser login is only available for ChatGPT"));
        }
        let random = || -> Result<String> {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(failure)?;
            Ok(URL_SAFE_NO_PAD.encode(bytes))
        };
        let verifier = random()?;
        let state = random()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        self.redactor
            .protect(vec![verifier.clone(), state.clone()])
            .map_err(failure)?;
        let mut url = Url::parse("https://auth.openai.com/oauth/authorize").map_err(failure)?;
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", client_id(self.id)?),
            ("redirect_uri", "http://localhost:1455/auth/callback"),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", &self.client_name),
        ]);
        Ok(Browser {
            url: url.into(),
            verifier,
            state,
        })
    }
    pub async fn browser_finish(
        &self,
        flow: Browser,
        callback: &str,
        cancel: &Cancellation,
    ) -> Result<Credential> {
        let code = flow.code(callback)?;
        self.redactor.protect(vec![code.clone()]).map_err(failure)?;
        self.exchange(
            &code,
            &flow.verifier,
            "http://localhost:1455/auth/callback",
            cancel,
        )
        .await
    }
    async fn exchange(
        &self,
        code: &str,
        verifier: &str,
        redirect: &str,
        cancel: &Cancellation,
    ) -> Result<Credential> {
        let (status,raw)=self.auth_post("/oauth/token",json!({"grant_type":"authorization_code","client_id":client_id(self.id)?,"code":code,"code_verifier":verifier,"redirect_uri":redirect}),true,cancel).await?;
        if !(200..300).contains(&status) {
            return Err(invalid(&format!("OAuth code exchange failed ({status})")));
        }
        let next = credential(self.id, &raw, None, now()?)?;
        self.redactor.protect(next.secrets()).map_err(failure)?;
        Ok(next)
    }
}

pub struct Device {
    code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    interval: f64,
    expires: f64,
}
impl Device {
    pub fn parse(id: Id, raw: &Value) -> Result<Self> {
        let code = string(
            raw,
            if id == Id::ChatGpt {
                "device_auth_id"
            } else {
                "device_code"
            },
        )?
        .to_owned();
        let user_code = string(raw, "user_code")?.to_owned();
        let interval = raw
            .get("interval")
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 3600.0)
            .unwrap_or(5.0);
        let expires = if id == Id::ChatGpt {
            900.0
        } else {
            raw.get("expires_in")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n > 0.0 && *n <= 86400.0)
                .ok_or_else(|| invalid("device response has invalid expiry"))?
        };
        let verification_uri = if id == Id::ChatGpt {
            "https://auth.openai.com/codex/device".into()
        } else {
            https(string(raw, "verification_uri")?)?
        };
        let verification_uri_complete = raw
            .get("verification_uri_complete")
            .and_then(Value::as_str)
            .map(https)
            .transpose()?;
        if code.is_empty() || user_code.is_empty() {
            return Err(invalid("incomplete device authorization"));
        }
        Ok(Self {
            code,
            user_code,
            verification_uri,
            verification_uri_complete,
            interval,
            expires,
        })
    }
}
fn https(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| invalid("invalid verification URL"))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(
            "verification URL must use HTTPS without credentials",
        ));
    }
    Ok(url.into())
}
pub struct Browser {
    pub url: String,
    verifier: String,
    state: String,
}
impl Browser {
    pub fn code(&self, callback: &str) -> Result<String> {
        let callback = callback.trim();
        if let Ok(url) = Url::parse(callback) {
            let values = url
                .query_pairs()
                .collect::<std::collections::BTreeMap<_, _>>();
            if values.get("state").map(|v| v.as_ref()) != Some(self.state.as_str()) {
                return Err(invalid("OAuth state mismatch"));
            }
            if values.contains_key("error") {
                return Err(invalid("OAuth authorization denied"));
            }
            return values
                .get("code")
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .ok_or_else(|| invalid("callback has no authorization code"));
        }
        let (code, state) = callback.split_once('#').unwrap_or((callback, ""));
        if !state.is_empty() && state != self.state {
            return Err(invalid("OAuth state mismatch"));
        }
        if code.is_empty() {
            return Err(invalid("no authorization code was pasted"));
        }
        Ok(code.into())
    }
}

pub async fn callback(
    listener: tokio::net::TcpListener,
    flow: &Browser,
    cancel: &Cancellation,
) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let operation = async {
        loop {
            let (mut socket, peer) = listener.accept().await.map_err(failure)?;
            if !peer.ip().is_loopback() {
                return Err(invalid("OAuth callback was not local"));
            }
            let mut buffer = Vec::new();
            let read = async {
                loop {
                    let mut bytes = [0u8; 1024];
                    let count = socket.read(&mut bytes).await.map_err(failure)?;
                    if count == 0 {
                        return Err(invalid("OAuth callback connection closed"));
                    }
                    buffer.extend_from_slice(&bytes[..count]);
                    if buffer.len() > 16 * 1024 {
                        return Err(invalid("OAuth callback headers exceed limit"));
                    }
                    if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                        return Ok(());
                    }
                }
            };
            tokio::time::timeout(Duration::from_secs(5), read)
                .await
                .map_err(|_| invalid("OAuth callback timed out"))??;
            let request = std::str::from_utf8(&buffer)
                .map_err(|_| invalid("invalid OAuth callback encoding"))?;
            let mut line = request.lines().next().unwrap_or("").split_whitespace();
            let method = line.next().unwrap_or("");
            let path = line.next().unwrap_or("");
            if method != "GET" || !path.starts_with("/auth/callback?") {
                socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .map_err(failure)?;
                continue;
            }
            let callback = format!("http://localhost:1455{path}");
            let result = flow.code(&callback);
            let response = if result.is_ok() {
                "HTTP/1.1 200 OK\r\nContent-Length: 34\r\nConnection: close\r\n\r\nSigned in. Return to your terminal."
            } else {
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            socket
                .write_all(response.as_bytes())
                .await
                .map_err(failure)?;
            if result == Err(invalid("OAuth state mismatch")) {
                continue;
            }
            result?;
            return Ok(callback);
        }
    };
    tokio::select! { biased; () = cancel.cancelled() => Err(Error::Cancelled), result = tokio::time::timeout(Duration::from_secs(300), operation) => result.map_err(|_| invalid("browser login timed out; retry with --method paste or device"))? }
}
