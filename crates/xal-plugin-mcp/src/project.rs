use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::invalid;
use serde_json::{Map, Value};
use xal_services::config::Configuration;
use xal_services::settings::Settings;
use xal_services::storage::{read_json, read_object, write_json};

use crate::config::{exact_keys, object, server_name, validate_server};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Session,
    Project,
    Global,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Session,
    Project,
    Global,
    Reject,
}

pub struct Discovery {
    pub path: PathBuf,
    pub additions: Map<String, Value>,
    pub conflicts: Vec<String>,
    pub notices: Vec<String>,
}

pub fn parse(value: &Value) -> io::Result<Map<String, Value>> {
    let root = object(value, ".mcp.json")?;
    exact_keys(root, ".mcp.json", &["mcpServers"])?;
    let servers = object(
        root.get("mcpServers").unwrap_or(&Value::Null),
        ".mcp.json.mcpServers",
    )?;
    servers
        .iter()
        .map(|(id, value)| {
            let path = format!(".mcp.json.mcpServers.{id}");
            server_name(id, &path)?;
            let mut server = object(value, &path)?.clone();
            let transport = match server.remove("type") {
                None | Some(Value::Null) => {
                    if server.contains_key("url") {
                        "http"
                    } else {
                        "stdio"
                    }
                }
                Some(Value::String(value)) if value == "stdio" => "stdio",
                Some(Value::String(value)) if value == "http" || value == "streamable-http" => {
                    "http"
                }
                _ => {
                    return Err(invalid(format!(
                        "{path}.type must be \"stdio\", \"http\", or \"streamable-http\""
                    )));
                }
            };
            if server.contains_key("transport") {
                return Err(invalid(format!("{path}.transport is not supported")));
            }
            server.insert("transport".into(), Value::String(transport.into()));
            validate_server(&server, &path, true)?;
            if transport == "http" {
                xal_services::mcp::validate_url(
                    server["url"]
                        .as_str()
                        .ok_or_else(|| invalid("MCP URL must be a string"))?,
                )?;
            }
            Ok((id.clone(), Value::Object(server)))
        })
        .collect()
}

pub fn discover(configuration: &Configuration, interactive: bool) -> io::Result<Discovery> {
    let path = configuration.project_root.join(".mcp.json");
    let mut discovery = Discovery {
        path,
        additions: Map::new(),
        conflicts: Vec::new(),
        notices: Vec::new(),
    };
    if !configuration.trusted {
        return Ok(discovery);
    }
    let Some(value) = read_json(&discovery.path)? else {
        return Ok(discovery);
    };
    let configured = raw_servers(&configuration.values, "configuration")?;
    for (id, value) in parse(&value)? {
        if configured.contains_key(&id) {
            discovery.conflicts.push(id);
        } else {
            discovery.additions.insert(id, value);
        }
    }
    if discovery.additions.is_empty() {
        return Ok(discovery);
    }
    discovery.notices.push(format!(
        "Detected {} with {} new MCP server{}.",
        discovery.path.display(),
        discovery.additions.len(),
        if discovery.additions.len() == 1 {
            ""
        } else {
            "s"
        }
    ));
    if !discovery.conflicts.is_empty() {
        discovery.notices.push(format!(
            "Keeping existing Xal configuration for: {}",
            discovery.conflicts.join(", ")
        ));
    }
    if !interactive {
        discovery.notices.push(format!(
            "Ignoring unapproved MCP servers from {}; launch interactively to use or import them.",
            discovery.path.display()
        ));
    }
    Ok(discovery)
}

pub fn approve(
    configuration: Configuration,
    home: &Path,
    cwd: &Path,
    interactive: bool,
    choice: Choice,
) -> io::Result<Configuration> {
    if choice == Choice::Reject {
        return Ok(configuration);
    }
    if !interactive || !configuration.trusted {
        return Err(invalid(
            "MCP discovery approval requires a trusted interactive launch",
        ));
    }
    let discovery = discover(&configuration, true)?;
    if discovery.additions.is_empty() {
        return Ok(configuration);
    }
    match choice {
        Choice::Session => {
            let mut values = configuration.values;
            let servers = servers_mut(&mut values)?;
            for (id, value) in discovery.additions {
                servers.entry(id).or_insert(value);
            }
            let settings = Settings::parse(&values)?;
            Ok(Configuration {
                values,
                settings,
                ..configuration
            })
        }
        Choice::Project | Choice::Global => {
            let path = match choice {
                Choice::Project => configuration.project_root.join(".xal/config.json"),
                Choice::Global => home.join("config.json"),
                _ => unreachable!(),
            };
            let mut values = read_object(&path)?;
            raw_servers(&values, &path.display().to_string())?;
            let servers = servers_mut(&mut values)?;
            for (id, value) in discovery.additions {
                servers.entry(id).or_insert(value);
            }
            Settings::parse(&values)?;
            write_json(&path, &Value::Object(values))?;
            Configuration::load(home, cwd)
        }
        Choice::Reject => unreachable!(),
    }
}

pub fn sources(configuration: &Configuration, home: &Path) -> io::Result<BTreeMap<String, Source>> {
    let global = read_object(&home.join("config.json"))?;
    let project = if configuration.trusted {
        read_object(&configuration.project_root.join(".xal/config.json"))?
    } else {
        Map::new()
    };
    let global = raw_servers(&global, "global config")?;
    let project = raw_servers(&project, "project config")?;
    Ok(raw_servers(&configuration.values, "configuration")?
        .keys()
        .map(|id| {
            (
                id.clone(),
                if project.contains_key(id) {
                    Source::Project
                } else if global.contains_key(id) {
                    Source::Global
                } else {
                    Source::Session
                },
            )
        })
        .collect())
}

pub fn delete(home: &Path, root: &Path, id: &str, source: Source) -> io::Result<()> {
    let path = match source {
        Source::Session => return Ok(()),
        Source::Project => root.join(".xal/config.json"),
        Source::Global => home.join("config.json"),
    };
    let mut values = read_object(&path)?;
    if !raw_servers(&values, &path.display().to_string())?.contains_key(id) {
        return Err(invalid(format!(
            "MCP server {id} is no longer defined in {}",
            path.display()
        )));
    }
    servers_mut(&mut values)?.remove(id);
    Settings::parse(&values)?;
    write_json(&path, &Value::Object(values))
}

fn raw_servers(values: &Map<String, Value>, path: &str) -> io::Result<Map<String, Value>> {
    let mut values = values;
    for key in ["pluginConfig", "mcp", "servers"] {
        let Some(value) = values.get(key) else {
            return Ok(Map::new());
        };
        values = object(value, &format!("{path}.{key}"))?;
    }
    Ok(values.clone())
}

fn servers_mut(values: &mut Map<String, Value>) -> io::Result<&mut Map<String, Value>> {
    let mut values = values;
    for key in ["pluginConfig", "mcp", "servers"] {
        values = values
            .entry(key)
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| invalid(format!("MCP configuration {key} must be an object")))?;
    }
    Ok(values)
}
