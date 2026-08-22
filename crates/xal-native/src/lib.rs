mod diff;
mod file_tools;
mod fuzzy;
mod git;
mod lsp;
mod mcp;
mod memory;
mod output_contract;
mod process;
mod redactor;
mod search;
mod shell;
mod skill;
mod tool_contracts;
mod tool_runtime;
mod web;
mod worktree;

use napi::bindgen_prelude::Utf16String;
use napi::{Error, Status};
use napi_derive::napi;
use redactor::SecretMatcher;

#[napi(js_name = "apiVersion", catch_unwind)]
pub fn api_version() -> u32 {
    10
}

#[napi]
pub struct NativeSecretMatcher {
    matcher: SecretMatcher,
}

#[napi]
impl NativeSecretMatcher {
    #[napi(constructor, catch_unwind)]
    pub fn new(values: Vec<Utf16String>, marker: Utf16String) -> napi::Result<Self> {
        let values = values.into_iter().map(|value| value.to_vec()).collect();
        let matcher = SecretMatcher::new(values, marker.to_vec())
            .map_err(|reason| Error::new(Status::InvalidArg, reason))?;
        Ok(Self { matcher })
    }

    #[napi(catch_unwind)]
    pub fn redact(&self, input: Utf16String) -> Utf16String {
        self.matcher.redact(&input).into()
    }
}
