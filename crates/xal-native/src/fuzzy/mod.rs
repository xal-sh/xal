#![cfg_attr(test, allow(dead_code))]

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Task};
use napi_derive::napi;

use crate::tool_contracts::{NativeToolOutcomeKind, cancellation_flag, io_error};
use xal_services::fuzzy;

#[napi(object)]
pub struct NativeFuzzyField {
    pub text: String,
    pub weight: f64,
}

#[napi(object)]
pub struct NativeFuzzyCandidate {
    pub fields: Vec<NativeFuzzyField>,
}

#[napi(js_name = "nativeBatchScores", catch_unwind)]
pub fn native_batch_scores(query: String, candidates: Vec<NativeFuzzyCandidate>) -> Vec<f64> {
    fuzzy::batch_scores(
        query,
        candidates
            .into_iter()
            .map(|candidate| fuzzy::FuzzyCandidate {
                fields: candidate
                    .fields
                    .into_iter()
                    .map(|field| fuzzy::FuzzyField {
                        text: field.text,
                        weight: field.weight,
                    })
                    .collect(),
            })
            .collect(),
    )
}

#[napi]
pub struct NativePathRanker {
    inner: fuzzy::PathRanker,
}

#[napi]
impl NativePathRanker {
    #[napi(constructor, catch_unwind)]
    pub fn new(paths: Vec<String>) -> Self {
        Self {
            inner: fuzzy::PathRanker::new(paths),
        }
    }

    #[napi(catch_unwind)]
    pub fn rank(&self, query: String, limit: u32) -> Vec<String> {
        self.inner.rank(query, limit)
    }
}

#[napi(object)]
pub struct NativeWorkspaceSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub paths: Vec<String>,
}

#[napi]
pub struct NativeWorkspaceIndex {
    inner: fuzzy::WorkspaceIndex,
}

pub struct WorkspaceIndexTask(fuzzy::WorkspaceIndexTask);

impl Task for WorkspaceIndexTask {
    type Output = fuzzy::WorkspaceIndex;
    type JsValue = NativeWorkspaceIndex;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(io_error)
    }

    fn resolve(&mut self, _env: Env, inner: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeWorkspaceIndex { inner })
    }
}

#[napi(js_name = "createWorkspaceIndex", catch_unwind)]
pub fn create_workspace_index(
    cwd: String,
    values: Vec<String>,
    marker: String,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorkspaceIndexTask> {
    AsyncTask::new(WorkspaceIndexTask(fuzzy::create_workspace_index(
        cwd,
        values,
        marker,
        cancellation_flag(signal),
    )))
}

pub struct WorkspaceSearchTask(fuzzy::WorkspaceSearchTask);

impl Task for WorkspaceSearchTask {
    type Output = fuzzy::WorkspaceSearchResult;
    type JsValue = NativeWorkspaceSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.0.compute().map_err(io_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeWorkspaceSearchResult {
            kind: output.kind.into(),
            paths: output.paths,
        })
    }
}

#[napi]
impl NativeWorkspaceIndex {
    #[napi(catch_unwind)]
    pub fn search(
        &self,
        query: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<WorkspaceSearchTask> {
        AsyncTask::new(WorkspaceSearchTask(
            self.inner.search(query, cancellation_flag(signal)),
        ))
    }
}
