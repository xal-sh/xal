#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::tool_contracts::cancellation_flag;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const STDERR_DISPLAY_LIMIT: usize = 500;
const MAX_ITEMS: usize = 250;

fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn cancelled(cancelled: &std::sync::atomic::AtomicBool) -> napi::Result<()> {
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(failed("LSP operation was cancelled"));
    }
    Ok(())
}

mod client;
mod config;
mod format;
mod manager;
mod query;
mod transport;

use client::RpcClient;
use config::{
    ServerConfig, ServerDefinition, client_key, environment, executable, match_server,
    may_resolve_from_another_root, server_root, unavailable_reason,
};
use format::{
    first_item, format_calls, format_diagnostics, format_hover, format_locations, format_symbols,
};
use manager::ManagerState;
use query::manager_query;
use transport::{
    file_uri, json_id, read_messages, read_stderr, terminate_process_tree, uri_path, write_message,
};
