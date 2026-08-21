use super::*;

#[napi(object)]
pub struct NativeWebFetchRequest {
    pub url: Option<String>,
    pub user_agent: String,
    pub allow_internal: Option<bool>,
}

pub struct WebFetchTask {
    request: NativeWebFetchRequest,
    cancelled: Arc<AtomicBool>,
}
async fn request_or_cancel(
    request: reqwest13::RequestBuilder,
    cancelled: &AtomicBool,
    url: &reqwest13::Url,
) -> napi::Result<Option<reqwest13::Response>> {
    let request = request.send();
    tokio::pin!(request);
    loop {
        tokio::select! {
            response = &mut request => {
                return response
                    .map(Some)
                    .map_err(|error| {
                        if error.is_timeout() {
                            failed(format!("Request timed out after {TIMEOUT_SECONDS} seconds: {url}"))
                        } else {
                            failed(error.to_string())
                        }
                    });
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(None);
                }
            }
        }
    }
}

async fn web_fetch(
    request: &NativeWebFetchRequest,
    cancelled: &AtomicBool,
) -> napi::Result<String> {
    let raw = request
        .url
        .as_deref()
        .filter(|url| !url.is_empty())
        .ok_or_else(|| invalid("url is required"))?;
    let url = reqwest13::Url::parse(raw)
        .map_err(|_| invalid(format!("Not a valid http or https URL: {raw}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(invalid(format!("Not a valid http or https URL: {raw}")));
    }
    if cancelled.load(Ordering::Relaxed) {
        return Ok(interrupted());
    }
    let addresses = if request.allow_internal == Some(true) {
        Vec::new()
    } else {
        resolve_target(&url).await?
    };
    if cancelled.load(Ordering::Relaxed) {
        return Ok(interrupted());
    }
    let mut client = Client::builder().redirect(Policy::none());
    if request.allow_internal != Some(true) {
        client = client.no_proxy();
    }
    if !addresses.is_empty() {
        let host = url
            .host_str()
            .ok_or_else(|| invalid(format!("URL has no host: {url}")))?;
        client = client.resolve_to_addrs(host, &addresses);
    }
    let client = client
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .build()
        .map_err(|error| failed(error.to_string()))?;
    let Some(response) = request_or_cancel(
        client
            .get(url.clone())
            .header(USER_AGENT, &request.user_agent)
            .header(
                ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            ),
        cancelled,
        &url,
    )
    .await?
    else {
        return Ok(interrupted());
    };
    let status = response.status();
    if status.is_redirection()
        && let Some(location) = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
    {
        let target = url.join(location).map_err(|_| {
            invalid(format!(
                "Redirected to an invalid location ({location}): {url}"
            ))
        })?;
        return Ok(format!(
            "Redirected to {target} — fetch that URL to read it."
        ));
    }
    if !status.is_success() {
        let reason = status
            .canonical_reason()
            .map(|reason| format!(" {reason}"))
            .unwrap_or_default();
        return Err(failed(format!(
            "Request failed with status {}{reason}: {url}",
            status.as_u16()
        )));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if binary_type(&content_type) {
        return Err(invalid(format!(
            "Cannot fetch binary content ({content_type}): {url}"
        )));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        tokio::select! {
            chunk = stream.next() => {
                let Some(chunk) = chunk else {
                    break;
                };
                let chunk = chunk.map_err(|error| failed(error.to_string()))?;
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(invalid(format!("Response exceeds the 5 MB limit: {url}")));
                }
                bytes.extend_from_slice(&chunk);
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(interrupted());
                }
            }
        }
    }
    let (text, _, _) = charset(&content_type).decode(&bytes);
    if text.contains('\0') {
        return Err(invalid(format!("Cannot fetch binary content: {url}")));
    }
    if text.trim().is_empty() {
        return Ok("(empty response)".to_owned());
    }
    if content_type.contains("text/html") || content_type.contains("application/xhtml") {
        Ok(html_to_markdown(text.into_owned()))
    } else {
        Ok(text.into_owned())
    }
}

impl Task for WebFetchTask {
    type JsValue = NativeToolOutput;
    type Output = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| failed(error.to_string()))?
            .block_on(web_fetch(&self.request, &self.cancelled))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeToolOutput {
            output: output.into(),
        })
    }
}

#[napi(js_name = "nativeWebFetch", catch_unwind)]
pub fn native_web_fetch(
    request: NativeWebFetchRequest,
    signal: Option<AbortSignal>,
) -> AsyncTask<WebFetchTask> {
    AsyncTask::new(WebFetchTask {
        request,
        cancelled: cancellation_flag(signal),
    })
}
