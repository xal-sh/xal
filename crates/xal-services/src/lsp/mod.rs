use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Error, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const STDERR_DISPLAY_LIMIT: usize = 500;
const MAX_ITEMS: usize = 250;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().expect("LSP state poisoned")
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidInput, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::other(message.into())
}

fn cancelled(cancelled: &dyn Fn() -> bool) -> std::io::Result<()> {
    if cancelled() {
        return Err(Error::new(
            ErrorKind::Interrupted,
            "LSP operation was cancelled",
        ));
    }
    Ok(())
}

mod client;
mod config;
mod format;
mod manager;
mod query;
mod transport;

#[cfg(not(windows))]
use transport::terminate_process_tree;

pub use config::{ParsedConfig, ServerConfig, ServerDefinition, parse_config};
pub use manager::Manager;
pub use query::{Operation, Query};

use client::RpcClient;
use config::{client_key, environment, executable, match_server, server_root, unavailable_reason};
use format::{
    first_item, format_calls, format_diagnostics, format_hover, format_locations, format_symbols,
};
use transport::{Writer, file_uri, json_id, read_messages, read_stderr, uri_path};
