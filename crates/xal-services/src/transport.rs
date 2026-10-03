use std::io;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest13::{Client, Response};

pub fn client() -> io::Result<Client> {
    Client::builder()
        .redirect(reqwest13::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .user_agent(concat!("xal/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(io::Error::other)
}

pub struct Sse {
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest13::Error>> + Send>>,
    pending: Vec<u8>,
    data: String,
}

impl Sse {
    pub fn new(response: Response) -> Self {
        Self {
            stream: Box::pin(response.bytes_stream()),
            pending: Vec::new(),
            data: String::new(),
        }
    }

    pub async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
                if end > 8 * 1024 * 1024 {
                    return Err(io::Error::other("provider SSE line exceeds 8 MiB"));
                }
                let line = self.pending.drain(..=end).collect::<Vec<_>>();
                let line = std::str::from_utf8(&line[..end])
                    .map_err(io::Error::other)?
                    .trim_end_matches('\r');
                if line.is_empty() && !self.data.is_empty() {
                    self.data.pop();
                    return Ok(Some(std::mem::take(&mut self.data)));
                }
                if let Some(value) = line.strip_prefix("data:") {
                    self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                    self.data.push('\n');
                }
                if self.data.len() > 8 * 1024 * 1024 {
                    return Err(io::Error::other("provider SSE event exceeds 8 MiB"));
                }
            }
            if self.pending.len() > 8 * 1024 * 1024 {
                return Err(io::Error::other("provider SSE line exceeds 8 MiB"));
            }
            match self.stream.next().await {
                Some(chunk) => self
                    .pending
                    .extend_from_slice(&chunk.map_err(io::Error::other)?),
                None if self.pending.is_empty() && self.data.is_empty() => return Ok(None),
                None => {
                    return Err(io::Error::other(
                        "provider stream ended within an SSE event",
                    ));
                }
            }
        }
    }
}

pub async fn json(mut response: Response, maximum: usize) -> io::Result<serde_json::Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(io::Error::other)? {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(io::Error::other("JSON response exceeds its size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    fn stream(bytes: &[u8], width: usize) -> Sse {
        Sse {
            stream: Box::pin(futures_util::stream::iter(
                bytes
                    .chunks(width)
                    .map(|bytes| Ok(Bytes::copy_from_slice(bytes)))
                    .collect::<Vec<_>>(),
            )),
            pending: Vec::new(),
            data: String::new(),
        }
    }

    #[test]
    fn sse_preserves_chunked_unicode_crlf_multiline_and_event_boundaries() {
        for width in [1, 7, 1024] {
            let mut stream = stream(
                "data: héllo\r\ndata: second\r\n\r\n:keepalive\n\ndata: final\n\n".as_bytes(),
                width,
            );
            assert_eq!(
                stream.next().now_or_never().unwrap().unwrap(),
                Some("héllo\nsecond".into())
            );
            assert_eq!(
                stream.next().now_or_never().unwrap().unwrap(),
                Some("final".into())
            );
            assert_eq!(stream.next().now_or_never().unwrap().unwrap(), None);
        }
    }

    #[test]
    fn sse_rejects_incomplete_invalid_and_oversized_records() {
        for bytes in [
            b"data: partial\n".to_vec(),
            b"data: \xff\n\n".to_vec(),
            [vec![b':'; 8 * 1024 * 1024 + 1], b"\n\n".to_vec()].concat(),
        ] {
            let mut stream = stream(&bytes, bytes.len());
            assert!(stream.next().now_or_never().unwrap().is_err());
        }
    }
}
