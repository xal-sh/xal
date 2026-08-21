use super::*;

pub(super) struct ToolRecord {
    pub(super) remote: Tool,
    pub(super) native_name: String,
    pub(super) output_schema: Option<Value>,
}
pub(super) fn capabilities(peer: &Peer<RoleClient>) -> Value {
    peer.peer_info()
        .and_then(|info| serde_json::to_value(&info.capabilities).ok())
        .unwrap_or_else(|| json!({}))
}

pub(super) fn has_capability(peer: &Peer<RoleClient>, capability: &str) -> bool {
    capabilities(peer).get(capability).is_some()
}

pub(super) async fn list_tools(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<Tool>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_tools(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.tools);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP tools catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP tools listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP tools listing", run).await
}

pub(super) async fn list_resources(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<Resource>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_resources(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.resources);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP resources catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP resources listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP resources listing", run).await
}

pub(super) async fn list_templates(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<ResourceTemplate>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_resource_templates(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.resource_templates);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed(
                    "MCP resource templates catalog exceeds 100000 entries",
                ));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP resource templates listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP resource templates listing", run).await
}

pub(super) async fn list_prompts(
    peer: &Peer<RoleClient>,
    duration: Duration,
) -> napi::Result<Vec<Prompt>> {
    let run = async {
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = None;
        loop {
            let result = peer
                .list_prompts(Some(
                    PaginatedRequestParams::default().with_cursor(cursor.clone()),
                ))
                .await
                .map_err(|error| failed(error.to_string()))?;
            items.extend(result.prompts);
            if items.len() > MAX_ITEMS_PER_CATALOG {
                return Err(failed("MCP prompts catalog exceeds 100000 entries"));
            }
            let Some(next) = result.next_cursor else {
                return Ok(items);
            };
            if !seen.insert(next.clone()) {
                return Err(failed("MCP prompts listing repeated a cursor"));
            }
            cursor = Some(next);
        }
    };
    timeout(duration, "MCP prompts listing", run).await
}

pub(super) fn json_values<T: serde::Serialize>(values: &[T]) -> napi::Result<Vec<Value>> {
    values
        .iter()
        .map(|value| serde_json::to_value(value).map_err(|error| failed(error.to_string())))
        .collect()
}

pub(super) fn native_tool_name(server: &str, tool: &str) -> String {
    let normalized = tool
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let normalized = if normalized.is_empty() {
        "tool".to_owned()
    } else {
        normalized
    };
    let base = format!("mcp__{server}__{normalized}");
    if normalized == tool && base.encode_utf16().count() <= 64 {
        return base;
    }
    let suffix = fnv_hash(&format!("{server}\0{tool}"));
    let maximum = 63_usize.saturating_sub(suffix.len());
    let prefix = base.encode_utf16().take(maximum).collect::<Vec<_>>();
    format!("{}_{}", String::from_utf16_lossy(&prefix), suffix)
}

fn fnv_hash(value: &str) -> String {
    let mut result = 2_166_136_261_u32;
    for unit in value.encode_utf16() {
        result = (result ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    radix36(result)
}

fn radix36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("radix output is ASCII")
}

pub(super) fn validate_output_schema(
    name: &str,
    schema: &Map<String, Value>,
) -> napi::Result<Value> {
    let schema = Value::Object(schema.clone());
    if schema.get("$async") == Some(&Value::Bool(true)) {
        return Err(failed(format!(
            "MCP tool {name} uses an unsupported asynchronous output schema"
        )));
    }
    let dialect = schema
        .get("$schema")
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('#'));
    if let Some(dialect) = dialect
        && !dialect.ends_with("json-schema.org/draft-07/schema")
        && !dialect.ends_with("json-schema.org/draft/2019-09/schema")
        && !dialect.ends_with("json-schema.org/draft/2020-12/schema")
    {
        return Err(failed(format!(
            "MCP tool {name} uses unsupported output schema dialect {dialect}"
        )));
    }
    jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .map_err(|error| {
            failed(format!(
                "MCP tool {name} has an invalid output schema: {error}"
            ))
        })?;
    Ok(schema)
}

pub(super) fn tool_records(
    server: &str,
    tools: Vec<Tool>,
) -> napi::Result<(Vec<ToolRecord>, Vec<String>, Vec<String>)> {
    let mut remote_names = HashSet::new();
    let mut native_names = HashSet::new();
    let mut records = Vec::new();
    let mut skipped_tasks = Vec::new();
    let mut skipped_output = Vec::new();
    for tool in tools {
        if !remote_names.insert(tool.name.to_string()) {
            return Err(failed(format!(
                "MCP server returned duplicate tool: {}",
                tool.name
            )));
        }
        let native_name = native_tool_name(server, &tool.name);
        if !native_names.insert(native_name.clone()) {
            return Err(failed(format!(
                "MCP tool names collide after normalization: {native_name}"
            )));
        }
        if tool
            .execution
            .as_ref()
            .and_then(|value| value.get("taskSupport"))
            .and_then(Value::as_str)
            == Some("required")
        {
            skipped_tasks.push(tool.name.to_string());
            continue;
        }
        let output_schema = match &tool.output_schema {
            Some(schema) => match validate_output_schema(&tool.name, schema) {
                Ok(schema) => Some(schema),
                Err(error) => {
                    skipped_output.push(format!("{}: {error}", tool.name));
                    continue;
                }
            },
            None => None,
        };
        records.push(ToolRecord {
            remote: tool,
            native_name,
            output_schema,
        });
    }
    Ok((records, skipped_tasks, skipped_output))
}

pub(super) async fn discover(
    peer: &Peer<RoleClient>,
    config: &ServerConfig,
) -> napi::Result<(
    Vec<ToolRecord>,
    Vec<Value>,
    Vec<Value>,
    Vec<Value>,
    Vec<String>,
    Vec<String>,
)> {
    let duration = config.timeout();
    let server = config.id();
    let (tools, resources, templates, prompts) = tokio::join!(
        async {
            if has_capability(peer, "tools") {
                list_tools(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "resources") {
                list_resources(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "resources") {
                list_templates(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if has_capability(peer, "prompts") {
                list_prompts(peer, duration).await
            } else {
                Ok(Vec::new())
            }
        }
    );
    let (tools, skipped_tasks, skipped_output) = tool_records(server, tools?)?;
    Ok((
        tools,
        json_values(&resources?)?,
        json_values(&templates?)?,
        json_values(&prompts?)?,
        skipped_tasks,
        skipped_output,
    ))
}

#[cfg(test)]
mod tests {
    use super::native_tool_name;

    #[test]
    fn normalizes_tool_names_stably() {
        assert_eq!(native_tool_name("server", "read"), "mcp__server__read");
        assert!(native_tool_name("server", "read tool").starts_with("mcp__server__read_tool_"));
        assert!(
            native_tool_name("server", &"x".repeat(100))
                .encode_utf16()
                .count()
                <= 64
        );
    }
}
