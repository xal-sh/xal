use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::context_sources::{check, invalid, read_text_with};
use crate::tool_contracts::normalize_path;

pub struct Request {
    pub name: String,
    pub directory: String,
    pub skill_path: String,
    pub body: String,
    pub resource: Option<String>,
}

pub(crate) fn walk_files(
    directory: &Path,
    boundary: Option<&Path>,
    cancelled: &AtomicBool,
) -> io::Result<Vec<PathBuf>> {
    fn walk(
        directory: &Path,
        boundary: Option<&Path>,
        visited: &mut HashSet<PathBuf>,
        files: &mut Vec<PathBuf>,
        cancelled: &AtomicBool,
    ) -> io::Result<()> {
        check(cancelled)?;
        let canonical = match fs::canonicalize(directory) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if boundary.is_some_and(|root| !canonical.starts_with(root))
            || !visited.insert(canonical.clone())
        {
            return Ok(());
        }
        let mut entries = fs::read_dir(&canonical)?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            check(cancelled)?;
            let path = directory.join(entry.file_name());
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        && entry.file_type()?.is_symlink() =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if metadata.is_dir() {
                walk(&path, boundary, visited, files, cancelled)?;
            } else if metadata.is_file() {
                let canonical = fs::canonicalize(&path)?;
                if boundary.is_none_or(|root| canonical.starts_with(root)) {
                    files.push(path);
                }
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(
        directory,
        boundary,
        &mut HashSet::new(),
        &mut files,
        cancelled,
    )?;
    Ok(files)
}

pub fn supporting_files(
    directory: &Path,
    skill_path: &Path,
    cancelled: &AtomicBool,
) -> io::Result<Vec<String>> {
    check(cancelled)?;
    let root = fs::canonicalize(directory)?;
    let skill_path = fs::canonicalize(skill_path)?;
    if !skill_path.starts_with(&root) {
        return Err(invalid("skill entry must stay inside the skill directory"));
    }
    let mut relative = Vec::new();
    for path in walk_files(&root, Some(&root), cancelled)? {
        if fs::canonicalize(&path)? == skill_path {
            continue;
        }
        relative.push(
            path.strip_prefix(&root)
                .map_err(io::Error::other)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    relative.sort();
    Ok(relative)
}

pub fn resources(files: &[String]) -> String {
    if files.is_empty() {
        return "Supporting files: none".into();
    }
    format!(
        "Supporting files:\n{}",
        files
            .iter()
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

pub fn execute(request: &Request, cancelled: &AtomicBool) -> io::Result<String> {
    check(cancelled)?;
    let root = fs::canonicalize(&request.directory)?;
    let Some(resource) = &request.resource else {
        let files = supporting_files(&root, Path::new(&request.skill_path), cancelled)?;
        return Ok(format!(
            "Skill: {}\n\nDirectory: {}\n\n{}\n\n{}",
            request.name,
            request.directory,
            resources(&files),
            request.body
        ));
    };
    if resource.is_empty() || Path::new(resource).is_absolute() {
        return Err(invalid("path must be relative to the skill directory"));
    }
    let candidate = normalize_path(&root.join(resource));
    if !candidate.starts_with(&root) {
        return Err(invalid("path must stay inside the skill directory"));
    }
    let path = fs::canonicalize(candidate).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            invalid(format!("skill file not found: {resource}"))
        } else {
            error
        }
    })?;
    if !path.starts_with(&root) {
        return Err(invalid("path must stay inside the skill directory"));
    }
    read_text_with(&path, Some(50_000), cancelled, |reason| {
        format!("skill {reason}: {resource}")
    })
}
