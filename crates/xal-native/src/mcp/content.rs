use super::*;

pub(super) fn json_pretty(value: &Value) -> napi::Result<String> {
    serde_json::to_string_pretty(value).map_err(|error| failed(error.to_string()))
}

fn binary(label: &str, mime_type: Option<&str>, data: &str) -> String {
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    let size = data.len().saturating_mul(3) / 4;
    format!(
        "[{label}: {}, {} bytes omitted]",
        mime_type.unwrap_or("unknown type"),
        size.saturating_sub(padding)
    )
}

pub(super) fn format_resource(value: &Value) -> napi::Result<String> {
    let uri = value
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("MCP resource content is malformed"))?;
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Ok(format!("[resource {uri}]\n{text}"));
    }
    let blob = value
        .get("blob")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("MCP resource content is malformed"))?;
    Ok(format!(
        "[resource {uri}]\n{}",
        binary(
            "binary resource",
            value.get("mimeType").and_then(Value::as_str),
            blob
        )
    ))
}

fn format_content(value: &Value) -> napi::Result<String> {
    match value.get("type").and_then(Value::as_str) {
        Some("text") => value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| failed("MCP text content is malformed")),
        Some("image") => Ok(binary(
            "image",
            value.get("mimeType").and_then(Value::as_str),
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP image content is malformed"))?,
        )),
        Some("audio") => Ok(binary(
            "audio",
            value.get("mimeType").and_then(Value::as_str),
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP audio content is malformed"))?,
        )),
        Some("resource_link") => Ok(format!(
            "[resource {}: {}]",
            value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("resource"),
            value
                .get("uri")
                .and_then(Value::as_str)
                .ok_or_else(|| failed("MCP resource link is malformed"))?
        )),
        Some("resource") => format_resource(
            value
                .get("resource")
                .ok_or_else(|| failed("MCP embedded resource is malformed"))?,
        ),
        _ => Err(failed("MCP content block is malformed")),
    }
}

pub(super) fn format_tool_result(value: &Value) -> napi::Result<String> {
    if let Some(legacy) = value.get("toolResult") {
        return json_pretty(legacy);
    }
    let mut sections = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| failed("MCP tool result is malformed"))?
        .iter()
        .map(format_content)
        .collect::<napi::Result<Vec<_>>>()?;
    if let Some(structured) = value.get("structuredContent") {
        sections.push(format!("Structured content:\n{}", json_pretty(structured)?));
    }
    sections.retain(|section| !section.is_empty());
    let output = if sections.is_empty() {
        "(empty MCP tool result)".to_owned()
    } else {
        sections.join("\n\n")
    };
    if value.get("isError").and_then(Value::as_bool) == Some(true) {
        return Ok(format!("MCP tool returned an error.\n\n{output}"));
    }
    Ok(output)
}

pub(super) fn format_prompt(value: &Value) -> napi::Result<String> {
    let mut sections = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| failed("MCP prompt result is malformed"))?
        .iter()
        .map(|message| {
            Ok(format!(
                "{}:\n{}",
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failed("MCP prompt message is malformed"))?,
                format_content(
                    message
                        .get("content")
                        .ok_or_else(|| failed("MCP prompt message is malformed"))?
                )?
            ))
        })
        .collect::<napi::Result<Vec<_>>>()?;
    if let Some(description) = value.get("description").and_then(Value::as_str) {
        sections.insert(0, description.to_owned());
    }
    if sections.is_empty() {
        return Ok("(empty MCP prompt)".to_owned());
    }
    Ok(sections.join("\n\n"))
}

pub(super) fn progress_text(params: &ProgressNotificationParam) -> String {
    if let Some(message) = &params.message {
        return message.clone();
    }
    let progress = number_text(params.progress);
    params.total.map_or_else(
        || format!("MCP progress {progress}"),
        |total| format!("MCP progress {progress}/{}", number_text(total)),
    )
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    value.to_string()
}
pub(super) fn output_validation(
    tool: &str,
    schema: Option<&Value>,
    result: &Value,
) -> napi::Result<()> {
    let Some(schema) = schema else {
        return Ok(());
    };
    if result.get("toolResult").is_some() {
        return Err(failed(format!(
            "MCP tool {tool} has an output schema but returned a legacy tool result"
        )));
    }
    let structured = result.get("structuredContent");
    let is_error = result.get("isError").and_then(Value::as_bool) == Some(true);
    if structured.is_none() && !is_error {
        return Err(failed(format!(
            "MCP tool {tool} has an output schema but returned no structured content"
        )));
    }
    let Some(structured) = structured else {
        return Ok(());
    };
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| failed(error.to_string()))?;
    let errors = validator.iter_errors(structured).collect::<Vec<_>>();
    if errors.is_empty() {
        return Ok(());
    }
    let detail = errors
        .iter()
        .map(|error| format!("{} {error}", error.instance_path()))
        .collect::<Vec<_>>()
        .join("; ");
    Err(failed(format!(
        "MCP tool {tool} returned invalid structured content: {detail}"
    )))
}

#[cfg(test)]
mod tests {
    use super::progress_text;
    use rmcp::model::{NumberOrString, ProgressNotificationParam, ProgressToken};

    #[test]
    fn formats_progress() {
        let progress = ProgressNotificationParam::new(
            ProgressToken(NumberOrString::String("call".into())),
            2.0,
        )
        .with_total(4.0);
        assert_eq!(progress_text(&progress), "MCP progress 2/4");
    }
}
