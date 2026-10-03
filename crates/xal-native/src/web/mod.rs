#![cfg_attr(test, allow(dead_code))]

use std::sync::{Arc, atomic::AtomicBool};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Task};
use napi_derive::napi;

use crate::file_tools::NativeToolOutput;
use crate::tool_contracts::{cancellation_flag, io_error};

#[napi(object)]
pub struct NativeWebFetchRequest {
    pub url: Option<String>,
    pub user_agent: String,
    pub allow_internal: Option<bool>,
}

pub struct WebFetchTask {
    request: xal_services::web::FetchRequest,
    cancelled: Arc<AtomicBool>,
}

impl Task for WebFetchTask {
    type JsValue = NativeToolOutput;
    type Output = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(io_error)?
            .block_on(xal_services::web::fetch(&self.request, &self.cancelled))
            .map_err(io_error)
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
        request: xal_services::web::FetchRequest {
            url: request.url,
            user_agent: request.user_agent,
            allow_internal: request.allow_internal,
        },
        cancelled: cancellation_flag(signal),
    })
}

#[napi(js_name = "nativeHtmlToMarkdown", catch_unwind)]
pub fn native_html_to_markdown(html: String) -> String {
    xal_services::web::html_to_markdown(html)
}
