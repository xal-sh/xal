use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{Stream, StreamExt};
use reqwest13::header::{ACCEPT, CONTENT_TYPE, HeaderName, HeaderValue, WWW_AUTHENTICATE};
use rmcp::model::{ClientJsonRpcMessage, JsonRpcMessage, ServerJsonRpcMessage};
use rmcp::transport::common::http_header::{
    EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE,
};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, InsufficientScopeError, SseError, StreamableHttpClient, StreamableHttpError,
    StreamableHttpPostResponse,
};
use sse_stream::{Sse, SseStream};

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_PREVIEW_BYTES: usize = 512;

#[derive(Clone)]
pub(super) struct HttpClient {
    inner: reqwest13::Client,
    timeout: Duration,
    last_post_status: Arc<AtomicU16>,
}

impl HttpClient {
    pub(super) fn new(inner: reqwest13::Client, timeout: Duration) -> Self {
        Self {
            inner,
            timeout,
            last_post_status: Arc::new(AtomicU16::new(0)),
        }
    }

    pub(super) fn allows_legacy_fallback(&self) -> bool {
        (400..500).contains(&self.last_post_status.load(Ordering::Relaxed))
    }

    async fn send(
        &self,
        request: reqwest13::RequestBuilder,
    ) -> Result<reqwest13::Response, StreamableHttpError<reqwest13::Error>> {
        tokio::time::timeout(self.timeout, request.send())
            .await
            .map_err(|_| {
                StreamableHttpError::UnexpectedServerResponse(Cow::Owned(format!(
                    "HTTP response headers timed out after {}ms",
                    self.timeout.as_millis()
                )))
            })?
            .map_err(StreamableHttpError::Client)
    }
}

fn apply_headers(
    mut request: reqwest13::RequestBuilder,
    headers: HashMap<HeaderName, HeaderValue>,
) -> Result<reqwest13::RequestBuilder, StreamableHttpError<reqwest13::Error>> {
    for (name, value) in headers {
        if name.as_str().eq_ignore_ascii_case("accept")
            || name.as_str().eq_ignore_ascii_case(HEADER_SESSION_ID)
            || name.as_str().eq_ignore_ascii_case(HEADER_LAST_EVENT_ID)
        {
            return Err(StreamableHttpError::ReservedHeaderConflict(
                name.to_string(),
            ));
        }
        request = request.header(name, value);
    }
    Ok(request)
}

fn scope(header: &str) -> Option<String> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in header.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        if index > 0
            && !header[..index].chars().next_back().is_some_and(|previous| {
                previous == ',' || previous == ';' || previous.is_whitespace()
            })
        {
            continue;
        }
        let candidate = &header[index..];
        if !candidate
            .as_bytes()
            .get(..6)
            .is_some_and(|value| value.eq_ignore_ascii_case(b"scope="))
        {
            continue;
        }
        let value = &candidate[6..];
        if let Some(quoted) = value.strip_prefix('"') {
            let mut escaped = false;
            for (end, character) in quoted.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if character == '\\' {
                    escaped = true;
                    continue;
                }
                if character == '"' {
                    return Some(quoted[..end].to_owned());
                }
            }
            return None;
        }
        let end = value
            .find(|character: char| {
                character == ',' || character == ';' || character.is_whitespace()
            })
            .unwrap_or(value.len());
        if end > 0 {
            return Some(value[..end].to_owned());
        }
    }
    None
}

fn check_authentication(
    response: &reqwest13::Response,
) -> Result<(), StreamableHttpError<reqwest13::Error>> {
    if !matches!(
        response.status(),
        reqwest13::StatusCode::UNAUTHORIZED | reqwest13::StatusCode::FORBIDDEN
    ) {
        return Ok(());
    }
    let Some(header) = response.headers().get(WWW_AUTHENTICATE) else {
        return Ok(());
    };
    let header = header.to_str().map_err(|_| {
        StreamableHttpError::UnexpectedServerResponse(Cow::Borrowed(
            "invalid www-authenticate header value",
        ))
    })?;
    match response.status() {
        reqwest13::StatusCode::UNAUTHORIZED => Err(StreamableHttpError::AuthRequired(
            AuthRequiredError::new(header.to_owned()),
        )),
        reqwest13::StatusCode::FORBIDDEN => Err(StreamableHttpError::InsufficientScope(
            InsufficientScopeError::new(header.to_owned(), scope(header)),
        )),
        _ => Ok(()),
    }
}

async fn body(
    response: reqwest13::Response,
    duration: Duration,
) -> Result<Bytes, StreamableHttpError<reqwest13::Error>> {
    let read = async {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
        {
            return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                format!("HTTP response exceeds {MAX_BODY_BYTES} bytes"),
            )));
        }
        let mut output = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(StreamableHttpError::Client)?;
            if output.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                    format!("HTTP response exceeds {MAX_BODY_BYTES} bytes"),
                )));
            }
            output.extend_from_slice(&chunk);
        }
        Ok(output.into())
    };
    tokio::time::timeout(duration, read).await.map_err(|_| {
        StreamableHttpError::UnexpectedServerResponse(Cow::Owned(format!(
            "HTTP response body timed out after {}ms",
            duration.as_millis()
        )))
    })?
}

fn preview(bytes: &[u8]) -> String {
    let end = bytes.len().min(MAX_ERROR_PREVIEW_BYTES);
    let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
    if bytes.len() > end {
        text.push('…');
    }
    text
}

fn json_rpc_error(bytes: &[u8]) -> Option<ServerJsonRpcMessage> {
    match serde_json::from_slice::<ServerJsonRpcMessage>(bytes) {
        Ok(message @ JsonRpcMessage::Error(_)) => Some(message),
        _ => None,
    }
}

struct EventLimiter<S> {
    inner: Pin<Box<S>>,
    max_bytes: usize,
    event_bytes: usize,
    line_bytes: usize,
    previous_cr: bool,
    failed: bool,
}

impl<S> EventLimiter<S> {
    fn new(inner: S, max_bytes: usize) -> Self {
        Self {
            inner: Box::pin(inner),
            max_bytes,
            event_bytes: 0,
            line_bytes: 0,
            previous_cr: false,
            failed: false,
        }
    }

    fn finish_line(&mut self) -> io::Result<()> {
        if self.line_bytes == 0 {
            self.event_bytes = 0;
        } else {
            self.event_bytes = self
                .event_bytes
                .saturating_add(self.line_bytes)
                .saturating_add(1);
            self.line_bytes = 0;
        }
        if self.event_bytes > self.max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("MCP SSE event exceeds {} bytes", self.max_bytes),
            ));
        }
        Ok(())
    }

    fn observe(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            if self.previous_cr {
                self.previous_cr = false;
                if *byte == b'\n' {
                    continue;
                }
            }
            if *byte == b'\r' {
                self.finish_line()?;
                self.previous_cr = true;
                continue;
            }
            if *byte == b'\n' {
                self.finish_line()?;
                continue;
            }
            self.line_bytes = self.line_bytes.saturating_add(1);
            if self.event_bytes.saturating_add(self.line_bytes) > self.max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("MCP SSE event exceeds {} bytes", self.max_bytes),
                ));
            }
        }
        Ok(())
    }
}

impl<S, E> Stream for EventLimiter<S>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.failed {
            return Poll::Ready(None);
        }
        match self.inner.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(bytes))) => {
                if let Err(error) = self.observe(&bytes) {
                    self.failed = true;
                    return Poll::Ready(Some(Err(error)));
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.failed = true;
                Poll::Ready(Some(Err(io::Error::other(error))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn sse_stream(
    response: reqwest13::Response,
    max_bytes: usize,
) -> BoxStream<'static, Result<Sse, SseError>> {
    SseStream::from_bytes_stream(EventLimiter::new(response.bytes_stream(), max_bytes)).boxed()
}

impl StreamableHttpClient for HttpClient {
    type Error = reqwest13::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            MAX_BODY_BYTES,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let mut request = self
            .inner
            .post(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "));
        if let Some(auth_header) = auth_header {
            request = request.bearer_auth(auth_header);
        }
        request = apply_headers(request, custom_headers)?;
        let session_was_attached = session_id.is_some();
        if let Some(session_id) = session_id {
            request = request.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        let response = self.send(request.json(&message)).await?;
        self.last_post_status
            .store(response.status().as_u16(), Ordering::Relaxed);
        check_authentication(&response)?;
        let status = response.status();
        if matches!(
            status,
            reqwest13::StatusCode::ACCEPTED | reqwest13::StatusCode::NO_CONTENT
        ) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == reqwest13::StatusCode::NOT_FOUND && session_was_attached {
            return Err(StreamableHttpError::SessionExpired);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        let content_length = response.content_length();
        let session_id = response
            .headers()
            .get(HEADER_SESSION_ID)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status.is_success()
            && content_length == Some(0)
            && matches!(
                message,
                ClientJsonRpcMessage::Notification(_)
                    | ClientJsonRpcMessage::Response(_)
                    | ClientJsonRpcMessage::Error(_)
            )
        {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if !status.is_success() {
            let bytes = body(response, self.timeout).await?;
            if content_type
                .as_deref()
                .is_some_and(|value| value.as_bytes().starts_with(JSON_MIME_TYPE.as_bytes()))
                && let Some(message) = json_rpc_error(&bytes)
            {
                return Ok(StreamableHttpPostResponse::Json(message, session_id));
            }
            return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                format!("HTTP {status}: {}", preview(&bytes)),
            )));
        }
        match content_type.as_deref() {
            Some(value)
                if value
                    .as_bytes()
                    .starts_with(EVENT_STREAM_MIME_TYPE.as_bytes()) =>
            {
                Ok(StreamableHttpPostResponse::Sse(
                    sse_stream(response, max_sse_event_size),
                    session_id,
                ))
            }
            Some(value) if value.as_bytes().starts_with(JSON_MIME_TYPE.as_bytes()) => {
                let bytes = body(response, self.timeout).await?;
                match serde_json::from_slice(&bytes) {
                    Ok(message) => Ok(StreamableHttpPostResponse::Json(message, session_id)),
                    Err(_) => Ok(StreamableHttpPostResponse::Accepted),
                }
            }
            _ => Err(StreamableHttpError::UnexpectedContentType(content_type)),
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let mut request = self
            .inner
            .delete(uri.as_ref())
            .header(HEADER_SESSION_ID, session_id.as_ref());
        if let Some(auth_header) = auth_header {
            request = request.bearer_auth(auth_header);
        }
        request = apply_headers(request, custom_headers)?;
        let response = self.send(request).await?;
        if response.status() == reqwest13::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        response
            .error_for_status()
            .map_err(StreamableHttpError::Client)?;
        Ok(())
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            MAX_BODY_BYTES,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        let mut request = self
            .inner
            .get(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "));
        if let Some(session_id) = session_id {
            request = request.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        if let Some(last_event_id) = last_event_id {
            request = request.header(HEADER_LAST_EVENT_ID, last_event_id);
        }
        if let Some(auth_header) = auth_header {
            request = request.bearer_auth(auth_header);
        }
        request = apply_headers(request, custom_headers)?;
        let response = self.send(request).await?;
        check_authentication(&response)?;
        let response = response
            .error_for_status()
            .map_err(StreamableHttpError::Client)?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        if !content_type.as_deref().is_some_and(|value| {
            value
                .as_bytes()
                .starts_with(EVENT_STREAM_MIME_TYPE.as_bytes())
        }) {
            return Err(StreamableHttpError::UnexpectedContentType(content_type));
        }
        Ok(sse_stream(response, max_sse_event_size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    #[test]
    fn parses_scope_parameter_boundaries() {
        assert_eq!(
            scope(r#"Bearer scope="files:read files:write""#),
            Some("files:read files:write".to_owned())
        );
        assert_eq!(scope("Bearer custom_scope=wrong"), None);
        assert_eq!(
            scope(r#"Bearer resource="https://example.test/scope=value""#),
            None
        );
    }

    #[tokio::test]
    async fn rejects_oversized_sse_events() {
        let source = stream::iter(vec![Ok::<_, io::Error>(Bytes::from_static(
            b"data: oversized\n\n",
        ))]);
        let mut limited = EventLimiter::new(source, 8);
        assert!(limited.next().await.expect("one result").is_err());
        assert!(limited.next().await.is_none());
    }
}
