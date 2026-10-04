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

mod content;
mod fetch;
mod security;

use content::{binary_type, charset, html_to_markdown};
use security::resolve_target;

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn interrupted() -> String {
    "(interrupted by user)".to_owned()
}
