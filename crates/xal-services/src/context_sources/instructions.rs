use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde_json::Map;
use serde_json::Value;

use super::{check, invalid, read_text};

#[derive(Clone, Debug)]
pub struct Source {
    pub path: PathBuf,
    pub content: String,
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub struct Instructions {
    pub root: PathBuf,
    pub sources: Vec<Source>,
    pub skipped: Vec<PathBuf>,
}

pub fn max_bytes(config: &Map<String, Value>) -> io::Result<usize> {
    let Some(value) = config.get("maxBytes") else {
        return Ok(32 * 1024);
    };
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0 && value.fract() == 0.0)
        .and_then(|value| format!("{value:.0}").parse().ok())
        .ok_or_else(|| invalid("project-instructions maxBytes must be a positive integer"))
}

pub fn load(cwd: &Path, max_bytes: usize, cancelled: &AtomicBool) -> io::Result<Instructions> {
    if max_bytes == 0 {
        return Err(invalid(
            "project-instructions maxBytes must be a positive integer",
        ));
    }
    let cwd = crate::tool_contracts::normalize_path(&std::path::absolute(cwd)?);
    let root = crate::config::project_root(&cwd)?;
    let mut result = Instructions {
        root: root.clone(),
        sources: Vec::new(),
        skipped: Vec::new(),
    };
    let mut remaining = max_bytes;
    for directory in cwd.ancestors() {
        check(cancelled)?;
        let path = directory.join("AGENTS.md");
        let content = match read_text(&path, None, cancelled) {
            Ok(content) => Some(content),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Some(content) = content.filter(|content| !content.trim().is_empty()) {
            let truncated = content.len() > remaining;
            let mut end = remaining.min(content.len());
            while !content.is_char_boundary(end) {
                end -= 1;
            }
            remaining = remaining.saturating_sub(content.len());
            if end == 0 {
                result.skipped.push(path);
            } else {
                result.sources.push(Source {
                    path,
                    content: content[..end].into(),
                    truncated,
                });
            }
        }
        if directory == root {
            break;
        }
    }
    result.sources.reverse();
    result.skipped.reverse();
    Ok(result)
}

impl Instructions {
    pub fn render(&self) -> String {
        if self.sources.is_empty() {
            return String::new();
        }
        let relative = |path: &Path| {
            path.strip_prefix(&self.root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned()
        };
        let mut sections = vec!["Project instructions follow. Instructions from files nearer the working directory take precedence when they conflict with earlier files.".to_owned()];
        for source in &self.sources {
            sections.push(format!(
                "## {}\n\n{}{}",
                relative(&source.path),
                source.content,
                if source.truncated {
                    "\n\n[This instruction file was truncated at the configured byte budget.]"
                } else {
                    ""
                }
            ));
        }
        if !self.skipped.is_empty() {
            sections.push(format!(
                "[Omitted at the configured byte budget: {}.]",
                self.skipped
                    .iter()
                    .map(|path| relative(path))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        sections.join("\n\n")
    }
}
