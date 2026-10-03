use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
use std::path::Path;

use crate::invalid;
use serde_json::{Map, Value};
use xal_services::mcp::ServerConfig;

pub struct Config {
    pub servers: Vec<ServerConfig>,
    pub secrets: Vec<String>,
}

pub fn parse(values: &Map<String, Value>, cwd: &Path) -> io::Result<Config> {
    parse_with_environment(values, cwd, &|name| match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(invalid(format!(
            "environment variable {name} is not valid Unicode"
        ))),
    })
}

pub fn parse_with_environment(
    values: &Map<String, Value>,
    cwd: &Path,
    environment: &dyn Fn(&str) -> io::Result<Option<String>>,
) -> io::Result<Config> {
    exact_keys(values, "pluginConfig.mcp", &["servers"])?;
    let mut servers = Vec::new();
    let mut secrets = BTreeSet::new();
    if let Some(value) = values.get("servers") {
        for (id, value) in object(value, "pluginConfig.mcp.servers")? {
            let path = format!("pluginConfig.mcp.servers.{id}");
            server_name(id, &path)?;
            let value = object(value, &path)?;
            validate_server(value, &path, false)?;
            let mut expand = |value: &str, path: &str, sensitive: bool| -> io::Result<String> {
                expand(value, path, sensitive, environment, &mut secrets)
            };
            let enabled = value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let timeout_ms = value
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30_000);
            let config = match value.get("transport").and_then(Value::as_str) {
                Some("stdio") => ServerConfig::Stdio {
                    id: id.clone(),
                    enabled,
                    timeout_ms,
                    command: expand(
                        text(&value["command"], &format!("{path}.command"))?,
                        &format!("{path}.command"),
                        false,
                    )?,
                    args: value
                        .get("args")
                        .map(|value| strings(value, &format!("{path}.args")))
                        .transpose()?
                        .unwrap_or_default()
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            expand(value, &format!("{path}.args[{index}]"), false)
                        })
                        .collect::<io::Result<_>>()?,
                    cwd: value
                        .get("cwd")
                        .map(|value| -> io::Result<_> {
                            let expanded = expand(
                                text(value, &format!("{path}.cwd"))?,
                                &format!("{path}.cwd"),
                                false,
                            )?;
                            Ok(xal_services::tool_contracts::normalize_path(
                                &cwd.join(expanded),
                            ))
                        })
                        .transpose()?,
                    env: expand_record(value.get("env"), &format!("{path}.env"), &mut expand)?,
                },
                Some("http") => ServerConfig::Http {
                    id: id.clone(),
                    enabled,
                    timeout_ms,
                    url: expand(
                        text(&value["url"], &format!("{path}.url"))?,
                        &format!("{path}.url"),
                        false,
                    )?,
                    headers: expand_record(
                        value.get("headers"),
                        &format!("{path}.headers"),
                        &mut expand,
                    )?,
                },
                _ => {
                    return Err(invalid(format!(
                        "{path}.transport must be \"stdio\" or \"http\""
                    )));
                }
            };
            config.validate()?;
            servers.push(config);
        }
    }
    Ok(Config {
        servers,
        secrets: secrets
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect(),
    })
}

pub(crate) fn object<'a>(value: &'a Value, path: &str) -> io::Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{path} must be an object")))
}

pub(crate) fn exact_keys(
    value: &Map<String, Value>,
    path: &str,
    allowed: &[&str],
) -> io::Result<()> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("{path}.{key} is not supported")));
    }
    Ok(())
}

pub(crate) fn server_name(id: &str, path: &str) -> io::Result<()> {
    if !id.starts_with(|c: char| c.is_ascii_lowercase())
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(invalid(format!(
            "{path} has an invalid server name; use lower-case letters, numbers, hyphens, and underscores"
        )));
    }
    Ok(())
}

fn text<'a>(value: &'a Value, path: &str) -> io::Result<&'a str> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid(format!("{path} must be a non-empty string")))
}

fn strings(value: &Value, path: &str) -> io::Result<Vec<String>> {
    serde_json::from_value(value.clone())
        .map_err(|_| invalid(format!("{path} must be an array of strings")))
}

fn record(value: &Value, path: &str) -> io::Result<BTreeMap<String, String>> {
    let result: BTreeMap<String, String> = serde_json::from_value(value.clone())
        .map_err(|_| invalid(format!("{path} must be an object of string values")))?;
    if result.keys().any(String::is_empty) {
        return Err(invalid(format!(
            "{path} must be an object of string values"
        )));
    }
    Ok(result)
}

pub(crate) fn validate_server(
    value: &Map<String, Value>,
    path: &str,
    project: bool,
) -> io::Result<()> {
    if value
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(invalid(format!("{path}.enabled must be a boolean")));
    }
    if value.get("timeoutMs").is_some_and(|value| {
        value
            .as_u64()
            .is_none_or(|value| value == 0 || value > 9_007_199_254_740_991)
    }) {
        return Err(invalid(format!(
            "{path}.timeoutMs must be a positive integer"
        )));
    }
    let transport = value.get("transport").and_then(Value::as_str);
    let fields: &[&str] = match (transport, project) {
        (Some("stdio"), true) => &[
            "transport",
            "command",
            "args",
            "cwd",
            "env",
            "enabled",
            "timeoutMs",
        ],
        (Some("http"), true) => &["transport", "url", "headers", "enabled", "timeoutMs"],
        (Some("stdio" | "http"), false) => &[
            "transport",
            "command",
            "args",
            "cwd",
            "env",
            "url",
            "headers",
            "enabled",
            "timeoutMs",
        ],
        _ => {
            return Err(invalid(format!(
                "{path}.transport must be \"stdio\" or \"http\""
            )));
        }
    };
    exact_keys(value, path, fields)?;
    match transport {
        Some("stdio") => {
            text(
                value.get("command").unwrap_or(&Value::Null),
                &format!("{path}.command"),
            )?;
            if let Some(value) = value.get("args") {
                strings(value, &format!("{path}.args"))?;
            }
            if let Some(value) = value.get("cwd") {
                text(value, &format!("{path}.cwd"))?;
            }
            if let Some(value) = value.get("env") {
                record(value, &format!("{path}.env"))?;
            }
        }
        Some("http") => {
            text(
                value.get("url").unwrap_or(&Value::Null),
                &format!("{path}.url"),
            )?;
            if let Some(value) = value.get("headers") {
                record(value, &format!("{path}.headers"))?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn sensitive(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "credential",
        "password",
        "secret",
        "token",
        "apikey",
        "api_key",
        "api-key",
    ]
    .iter()
    .any(|key| name.contains(key))
}

fn expand(
    value: &str,
    path: &str,
    secret: bool,
    environment: &dyn Fn(&str) -> io::Result<Option<String>>,
    secrets: &mut BTreeSet<String>,
) -> io::Result<String> {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let Some(end) = remaining.find('}') else {
            break;
        };
        let name = &remaining[2..end];
        if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            output.push_str("${");
            remaining = &remaining[2..];
            continue;
        }
        let resolved = environment(name)?.ok_or_else(|| {
            invalid(format!(
                "{path} references missing environment variable {name}"
            ))
        })?;
        if secret || sensitive(name) {
            secrets.insert(resolved.clone());
        }
        output.push_str(&resolved);
        remaining = &remaining[end + 1..];
    }
    output.push_str(remaining);
    if secret {
        secrets.insert(output.clone());
    }
    Ok(output)
}

fn expand_record(
    value: Option<&Value>,
    path: &str,
    expand: &mut dyn FnMut(&str, &str, bool) -> io::Result<String>,
) -> io::Result<HashMap<String, String>> {
    value
        .map(|value| record(value, path))
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .map(|(key, value)| {
            Ok((
                key.clone(),
                expand(&value, &format!("{path}.{key}"), sensitive(&key))?,
            ))
        })
        .collect()
}
