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

pub fn retry_after(value: &str, now: std::time::SystemTime) -> Option<u64> {
    if let Ok(seconds) = value.trim().parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0)
            .then(|| (seconds.min(120.0) * 1000.0).round() as u64);
    }
    let parts = value.split_whitespace().collect::<Vec<_>>();
    let [_, day, month, year, time, "GMT"] = parts.as_slice() else {
        return None;
    };
    let day = day.parse::<u64>().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| m == month)?;
    let year = year
        .parse::<u64>()
        .ok()
        .filter(|y| (1970..=9999).contains(y))?;
    let leap = |year: u64| {
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
    };
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > months[month] {
        return None;
    }
    let clock = time
        .split(':')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let [hour, minute, second] = clock.as_slice() else {
        return None;
    };
    if *hour > 23 || *minute > 59 || *second > 59 {
        return None;
    }
    let days = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..month].iter().sum::<u64>()
        + day
        - 1;
    let at = std::time::UNIX_EPOCH
        + Duration::from_secs(days * 86400 + hour * 3600 + minute * 60 + second);
    Some(
        at.duration_since(now)
            .unwrap_or_default()
            .as_millis()
            .min(120_000) as u64,
    )
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
    fn retry_after_accepts_seconds_and_http_dates_with_a_bound() {
        let now = std::time::UNIX_EPOCH + Duration::from_secs(784_111_777);
        assert_eq!(retry_after("1.5", now), Some(1500));
        assert_eq!(retry_after("900", now), Some(120000));
        assert_eq!(
            retry_after("Sun, 06 Nov 1994 08:49:38 GMT", now),
            Some(1000)
        );
        assert_eq!(retry_after("Sun, 06 Nov 1994 08:49:36 GMT", now), Some(0));
        for value in ["NaN", "-1", "invalid", "Sun, 31 Feb 1994 08:49:37 GMT"] {
            assert_eq!(retry_after(value, now), None);
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
