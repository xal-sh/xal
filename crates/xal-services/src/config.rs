use std::env;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use crate::settings::{Settings, js_trim};
use crate::storage::{invalid, malformed, read_json, read_object, write_json};

pub struct Configuration {
    pub project_root: PathBuf,
    pub trusted: bool,
    pub values: Map<String, Value>,
    pub settings: Settings,
}

pub fn agent_home(override_home: Option<&str>, user_home: Option<PathBuf>) -> io::Result<PathBuf> {
    match override_home.map(js_trim).filter(|value| !value.is_empty()) {
        Some(value) => Ok(PathBuf::from(value)),
        None => user_home
            .map(|home| home.join(".xal"))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot determine user home")),
    }
}

pub fn project_root(cwd: &Path) -> io::Result<PathBuf> {
    let mut start = PathBuf::new();
    for component in std::path::absolute(cwd)?.components() {
        match component {
            Component::ParentDir => {
                start.pop();
            }
            Component::CurDir => {}
            component => start.push(component),
        }
    }
    let mut directory = start.as_path();
    loop {
        if directory.join(".git").try_exists()? {
            return Ok(directory.to_path_buf());
        }
        let Some(parent) = directory.parent() else {
            return Ok(start);
        };
        directory = parent;
    }
}

pub fn trusted_roots(home: &Path) -> io::Result<Vec<String>> {
    let path = home.join("trust.json");
    match read_json(&path)? {
        None => Ok(Vec::new()),
        Some(Value::Array(entries)) => entries
            .into_iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| malformed(&path))
            })
            .collect(),
        Some(_) => Err(malformed(&path)),
    }
}

pub fn set_trust(home: &Path, root: &Path, trusted: bool) -> io::Result<()> {
    let root = root
        .to_str()
        .ok_or_else(|| invalid("project root is not valid Unicode"))?;
    let mut roots = trusted_roots(home)?;
    if roots.iter().any(|entry| entry == root) == trusted {
        return Ok(());
    }
    if trusted {
        roots.push(root.into());
    } else {
        roots.retain(|entry| entry != root);
    }
    write_json(&home.join("trust.json"), &serde_json::to_value(roots)?)
}

impl Configuration {
    pub fn load(home: &Path, cwd: &Path) -> io::Result<Self> {
        let project_root = project_root(cwd)?;
        let trusted = trusted_roots(home)?
            .iter()
            .any(|entry| project_root.to_str() == Some(entry));
        let mut values = read_object(&home.join("config.json"))?;
        if trusted {
            merge(
                &mut values,
                read_object(&project_root.join(".xal/config.json"))?,
            );
        }
        let settings = Settings::parse(&values)?;
        Ok(Self {
            project_root,
            trusted,
            values,
            settings,
        })
    }

    pub fn save(home: &Path, cwd: &Path, patch: Map<String, Value>) -> io::Result<Self> {
        let project_root = project_root(cwd)?;
        let trusted = trusted_roots(home)?
            .iter()
            .any(|entry| project_root.to_str() == Some(entry));
        let mut values = read_object(&home.join("config.json"))?;
        if patch.contains_key("typesafeAI") {
            for field in [
                "compaction",
                "codeSearch",
                "reasoningRouting",
                "automaticThinking",
            ] {
                values.remove(field);
            }
        }
        merge(&mut values, patch);
        let mut effective = values.clone();
        if trusted {
            merge(
                &mut effective,
                read_object(&project_root.join(".xal/config.json"))?,
            );
        }
        let settings = Settings::parse(&effective)?;
        write_json(&home.join("config.json"), &Value::Object(values))?;
        Ok(Self {
            project_root,
            trusted,
            values: effective,
            settings,
        })
    }

    pub fn redaction_values(&self) -> io::Result<Vec<String>> {
        let mut values = self.settings.redaction_values.clone();
        for name in &self.settings.redaction_environment {
            match env::var(name) {
                Ok(value) => values.push(value),
                Err(env::VarError::NotPresent) => {}
                Err(env::VarError::NotUnicode(_)) => {
                    return Err(invalid("redaction environment value is not valid Unicode"));
                }
            }
        }
        values.retain(|value| !value.is_empty());
        Ok(values)
    }

    pub fn has_external_plugins(&self) -> bool {
        !self.settings.plugins.is_empty()
    }
}

fn merge(lower: &mut Map<String, Value>, higher: Map<String, Value>) {
    for (key, value) in higher {
        match (lower.get_mut(&key), value) {
            (Some(Value::Object(previous)), Value::Object(value)) => merge(previous, value),
            (_, value) => {
                lower.insert(key, value);
            }
        }
    }
}
