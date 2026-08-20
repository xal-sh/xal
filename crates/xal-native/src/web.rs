#![cfg_attr(test, allow(dead_code))]

use std::io::Read;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;

use crate::file_tools::NativeToolOutput;
use crate::tool_contracts::cancellation_flag;

const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT_SECONDS: u64 = 30;

#[napi(object)]
pub struct NativeWebFetchRequest {
    pub url: Option<String>,
    pub user_agent: String,
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

impl Task for WebFetchTask {
    type JsValue = NativeToolOutput;
    type Output = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let raw = self
            .request
            .url
            .as_deref()
            .filter(|url| !url.is_empty())
            .ok_or_else(|| invalid("url is required"))?;
        let url = reqwest::Url::parse(raw)
            .map_err(|_| invalid(format!("Not a valid http or https URL: {raw}")))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(invalid(format!("Not a valid http or https URL: {raw}")));
        }
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(interrupted());
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(TIMEOUT_SECONDS))
            .build()
            .map_err(|error| failed(error.to_string()))?;
        let response = client
            .get(url.clone())
            .header(USER_AGENT, &self.request.user_agent)
            .header(
                ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            )
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    failed(format!(
                        "Request timed out after {TIMEOUT_SECONDS} seconds: {url}"
                    ))
                } else {
                    failed(error.to_string())
                }
            })?;
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(interrupted());
        }
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
        let mut reader = response;
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 16 * 1024];
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                return Ok(interrupted());
            }
            let count = reader
                .read(&mut chunk)
                .map_err(|error| failed(error.to_string()))?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > MAX_RESPONSE_BYTES {
                return Err(invalid(format!("Response exceeds the 5 MB limit: {url}")));
            }
            bytes.extend_from_slice(&chunk[..count]);
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
