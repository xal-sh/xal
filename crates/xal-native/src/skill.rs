#![cfg_attr(test, allow(dead_code))]

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

use crate::file_tools::NativeToolOutput;

#[napi(object)]
pub struct NativeSkillRequest {
    pub name: String,
    pub directory: String,
    pub skill_path: String,
    pub body: String,
    pub resource: Option<String>,
}

pub struct SkillTask(xal_services::skill::Request);

impl Task for SkillTask {
    type JsValue = NativeToolOutput;
    type Output = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        xal_services::skill::execute(&self.0, &std::sync::atomic::AtomicBool::new(false))
            .map_err(crate::tool_contracts::io_error)
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeToolOutput {
            output: output.into(),
        })
    }
}

#[napi(js_name = "nativeSkill", catch_unwind)]
pub fn native_skill(request: NativeSkillRequest) -> AsyncTask<SkillTask> {
    AsyncTask::new(SkillTask(xal_services::skill::Request {
        name: request.name,
        directory: request.directory,
        skill_path: request.skill_path,
        body: request.body,
        resource: request.resource,
    }))
}
