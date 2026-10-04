use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use encoding_rs::{Encoding, UTF_8};
use futures_util::StreamExt;
use reqwest13::Client;
use reqwest13::header::{ACCEPT, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest13::redirect::Policy;
use std::io::{self, Error};

const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT_SECONDS: u64 = 30;

mod content;
mod fetch;
mod security;

use content::{binary_type, charset, html_to_markdown};
pub use fetch::{FetchRequest, fetch};
use security::resolve_target;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::other(message.into())
}

fn interrupted() -> String {
    "(interrupted by user)".to_owned()
}

pub fn subject(raw: &str) -> String {
    let Ok(mut url) = reqwest13::Url::parse(raw) else {
        return raw.into();
    };
    if !["http", "https"].contains(&url.scheme()) {
        return raw.into();
    }
    if url.set_username("").is_err() || url.set_password(None).is_err() {
        return raw.into();
    }
    url.into()
}
