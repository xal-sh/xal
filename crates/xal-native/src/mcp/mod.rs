#![cfg_attr(test, allow(dead_code))]

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Duration;

use futures_util::StreamExt;
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;
use rmcp::ServiceExt;
use rmcp::handler::client::ClientHandler;
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, ClientCapabilities, ClientInfo, ClientRequest,
    Implementation, PaginatedRequestParams, ProgressNotificationParam, Prompt,
    ReadResourceRequestParams, Resource, ResourceTemplate, ServerResult, Tool,
};
use rmcp::service::{
    NotificationContext, Peer, PeerRequestOptions, RoleClient, RunningService, RxJsonRpcMessage,
    TxJsonRpcMessage,
};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, Transport};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::runtime::Runtime;

use crate::tool_contracts::cancellation_flag;

const PROGRESS_CAPACITY: usize = 32;
const MAX_ITEMS_PER_CATALOG: usize = 2_048;
const MAX_PAGES_PER_CATALOG: usize = 100;
const MAX_CURSOR_BYTES: usize = 64 * 1024;
const MAX_LEGACY_SSE_BUFFER_BYTES: usize = 16 * 1024 * 1024;

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

mod call;
mod config;
mod content;
mod discovery;
mod handler;
mod http;
mod lifecycle;
mod manager;
mod state;
mod stdio;
mod task;
mod transport;

use call::{CallShared, NativeMcpCall, ProgressReceiver, ToolCallRequest, await_tool_response};
use config::ServerConfig;
use content::{
    format_prompt, format_resource, format_tool_result, json_pretty, output_validation,
    progress_text,
};
use discovery::{
    ToolRecord, discover, has_capability, json_values, list_prompts, list_resources,
    list_templates, list_tools, tool_records,
};
use handler::{Handler, HandlerState, ProgressEvent};
use http::HttpClient;
use lifecycle::{close_all, connect_entry, connected_peer, refresh_entry, remove_entry};
use state::{Entry, ManagerState, connected_entries, server_status, tool_descriptors};
use stdio::{StderrTail, StdioTransport, stderr_text};
use task::{ManagerOperation, ManagerTask};
use transport::{cancellable, close_service, connect_service, timeout, with_stderr};

fn client_info(name: String, version: String) -> ClientInfo {
    ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new(name, version),
    )
}
