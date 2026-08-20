#![cfg_attr(test, allow(dead_code))]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::file_tools::NativeToolOutput;

const MAX_RESOURCE_BYTES: u64 = 50_000;

#[napi(object)]
pub struct NativeSkillRequest {
    pub name: String,
    pub directory: String,
    pub skill_path: String,
    pub body: String,
    pub resource: Option<String>,
}

pub struct SkillTask {
    request: NativeSkillRequest,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn walk(
    directory: &Path,
    root: &Path,
    visited: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> napi::Result<()> {
    let canonical = match fs::canonicalize(directory) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failed(error.to_string())),
    };
    if !inside(root, &canonical) || !visited.insert(canonical.clone()) {
        return Ok(());
    }
    let mut entries = fs::read_dir(&canonical)
        .map_err(|error| failed(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| failed(error.to_string()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::metadata(&path).map_err(|error| failed(error.to_string()))?;
        if metadata.is_dir() {
            walk(&path, root, visited, files)?;
        } else if metadata.is_file() {
            let canonical = fs::canonicalize(&path).map_err(|error| failed(error.to_string()))?;
            if inside(root, &canonical) {
                files.push(path);
            }
        }
    }
    Ok(())
}

fn list(request: &NativeSkillRequest, root: &Path) -> napi::Result<String> {
    let mut files = Vec::new();
    walk(root, root, &mut HashSet::new(), &mut files)?;
    let skill_path =
        fs::canonicalize(&request.skill_path).map_err(|error| failed(error.to_string()))?;
    let mut relative = files
        .into_iter()
        .filter_map(|path| {
            let canonical = fs::canonicalize(&path).ok()?;
            if canonical == skill_path {
                return None;
            }
            path.strip_prefix(root)
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    relative.sort();
    let resources = if relative.is_empty() {
        "Supporting files: none".to_owned()
    } else {
        format!(
            "Supporting files:\n{}",
            relative
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(format!(
        "Skill: {}\n\nDirectory: {}\n\n{resources}\n\n{}",
        request.name, request.directory, request.body
    ))
}

fn read_resource(resource: &str, root: &Path) -> napi::Result<String> {
    if resource.is_empty() || Path::new(resource).is_absolute() {
        return Err(invalid("path must be relative to the skill directory"));
    }
    let candidate = root.join(resource);
    if !inside(root, &candidate) {
        return Err(invalid("path must stay inside the skill directory"));
    }
    let path = fs::canonicalize(&candidate).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            invalid(format!("skill file not found: {resource}"))
        } else {
            failed(error.to_string())
        }
    })?;
    if !inside(root, &path) {
        return Err(invalid("path must stay inside the skill directory"));
    }
    let metadata = fs::metadata(&path).map_err(|error| failed(error.to_string()))?;
    if !metadata.is_file() {
        return Err(invalid(format!("skill path is not a file: {resource}")));
    }
    if metadata.len() > MAX_RESOURCE_BYTES {
        return Err(invalid(format!(
            "skill file exceeds {MAX_RESOURCE_BYTES} bytes: {resource}"
        )));
    }
    let bytes = fs::read(path).map_err(|error| failed(error.to_string()))?;
    if bytes.contains(&0) {
        return Err(invalid(format!("skill file is binary: {resource}")));
    }
    String::from_utf8(bytes)
        .map_err(|_| invalid(format!("skill file is not valid UTF-8: {resource}")))
}

impl Task for SkillTask {
    type JsValue = NativeToolOutput;
    type Output = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let root =
            fs::canonicalize(&self.request.directory).map_err(|error| failed(error.to_string()))?;
        match &self.request.resource {
            Some(resource) => read_resource(resource, &root),
            None => list(&self.request, &root),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(NativeToolOutput {
            output: output.into(),
        })
    }
}

#[napi(js_name = "nativeSkill", catch_unwind)]
pub fn native_skill(request: NativeSkillRequest) -> AsyncTask<SkillTask> {
    AsyncTask::new(SkillTask { request })
}
