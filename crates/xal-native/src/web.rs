#![cfg_attr(test, allow(dead_code))]

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};
use futures_util::StreamExt;
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use reqwest13::Client;
use reqwest13::header::{ACCEPT, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest13::redirect::Policy;

use crate::file_tools::NativeToolOutput;
use crate::tool_contracts::cancellation_flag;

const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT_SECONDS: u64 = 30;

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

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn interrupted() -> String {
    "(interrupted by user)".to_owned()
}

fn internal_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
                || address.is_multicast()
                || octets[0] >= 240
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || address.is_multicast()
                || address
                    .to_ipv4()
                    .is_some_and(|address| internal_address(IpAddr::V4(address)))
        }
    }
}

async fn resolve_target(url: &reqwest13::Url) -> napi::Result<Vec<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or_else(|| invalid(format!("URL has no host: {url}")))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid(format!("URL has no port: {url}")))?;
    let host = host.to_owned();
    let addresses = tokio::time::timeout(
        Duration::from_secs(TIMEOUT_SECONDS),
        tokio::task::spawn_blocking(move || {
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect::<Vec<_>>())
        }),
    )
    .await
    .map_err(|_| {
        failed(format!(
            "DNS lookup timed out after {TIMEOUT_SECONDS} seconds: {url}"
        ))
    })?
    .map_err(|error| failed(error.to_string()))?
    .map_err(|error| failed(error.to_string()))?;
    if addresses.is_empty() {
        return Err(failed(format!("URL host did not resolve: {url}")));
    }
    if addresses
        .iter()
        .any(|address| internal_address(address.ip()))
    {
        return Err(invalid(format!(
            "URL resolves to an internal address: {url}"
        )));
    }
    Ok(addresses)
}

fn binary_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("video/")
        || content_type.starts_with("font/")
        || content_type.contains("application/octet-stream")
        || content_type.contains("application/pdf")
        || content_type.contains("application/zip")
}

fn charset(content_type: &str) -> &'static Encoding {
    let label = content_type.split(';').skip(1).find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name.trim().eq_ignore_ascii_case("charset") {
            Some(value.trim().trim_matches(['\'', '"']).as_bytes())
        } else {
            None
        }
    });
    label.and_then(Encoding::for_label).unwrap_or(UTF_8)
}

fn remove_element(mut html: String, tag: &str) -> String {
    loop {
        let lower = html.to_ascii_lowercase();
        let Some(start) = lower.find(&format!("<{tag}")) else {
            return html;
        };
        let Some(open_end) = lower[start..].find('>').map(|end| start + end + 1) else {
            return html;
        };
        let Some(close) = lower[open_end..]
            .find(&format!("</{tag}>"))
            .map(|close| open_end + close + tag.len() + 3)
        else {
            html.replace_range(start..open_end, "");
            continue;
        };
        html.replace_range(start..close, "");
    }
}

fn html_to_markdown(html: String) -> String {
    let html = ["script", "style", "noscript"]
        .into_iter()
        .fold(html, remove_element);
    let markdown = html2md::parse_html(&html);
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut normalized = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        if let Some(underline) = lines.get(index + 1) {
            let marker = underline.trim();
            if !lines[index].trim().is_empty()
                && marker.len() >= 3
                && marker.chars().all(|character| character == '=')
            {
                normalized.push(format!("# {}", lines[index].trim()));
                index += 2;
                continue;
            }
            if !lines[index].trim().is_empty()
                && marker.len() >= 3
                && marker.chars().all(|character| character == '-')
            {
                normalized.push(format!("## {}", lines[index].trim()));
                index += 2;
                continue;
            }
        }
        normalized.push(lines[index].to_owned());
        index += 1;
    }
    normalized.join("\n").trim().to_owned()
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

#[napi(js_name = "nativeHtmlToMarkdown", catch_unwind)]
pub fn native_html_to_markdown(html: String) -> String {
    html_to_markdown(html)
}

#[cfg(test)]
mod tests {
    use super::internal_address;

    #[test]
    fn blocks_ipv4_compatible_internal_ipv6_addresses() {
        assert!(internal_address("::127.0.0.1".parse().unwrap()));
        assert!(internal_address("::10.0.0.1".parse().unwrap()));
    }
}
