use super::*;

fn values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(values) => values.iter().collect(),
        value => vec![value],
    }
}

type Point = (u64, u64);
type Range = (Point, Point);
type Location = (String, Range);
type CallItem = (String, String, String, Range);

fn position(value: &Value) -> Option<Point> {
    let object = value.as_object()?;
    Some((
        object.get("line")?.as_u64()?,
        object.get("character")?.as_u64()?,
    ))
}

fn range(value: &Value) -> Option<Range> {
    Some((position(value.get("start")?)?, position(value.get("end")?)?))
}

fn location(value: &Value) -> Option<Location> {
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))?
        .as_str()?
        .to_owned();
    let at = value
        .get("range")
        .and_then(range)
        .or_else(|| value.get("targetSelectionRange").and_then(range))
        .or_else(|| value.get("targetRange").and_then(range))?;
    Some((uri, at))
}

fn display_path(uri: &str, cwd: &str) -> String {
    let Some(path) = uri_path(uri) else {
        return uri.to_owned();
    };
    let cwd = Path::new(cwd);
    path.strip_prefix(cwd)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map_or_else(
            || path.display().to_string(),
            |relative| relative.display().to_string(),
        )
}

fn location_text(uri: &str, at: Range, cwd: &str) -> String {
    format!(
        "{}:{}:{}-{}:{}",
        display_path(uri, cwd),
        at.0.0 + 1,
        at.0.1 + 1,
        at.1.0 + 1,
        at.1.1 + 1
    )
}

fn bounded(header: String, lines: Vec<String>) -> String {
    if lines.len() <= MAX_ITEMS {
        return std::iter::once(header)
            .chain(lines)
            .collect::<Vec<_>>()
            .join("\n");
    }
    let omitted = lines.len() - MAX_ITEMS;
    std::iter::once(header)
        .chain(lines.into_iter().take(MAX_ITEMS))
        .chain(std::iter::once(format!(
            "... {omitted} more results omitted"
        )))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn format_locations(
    value: &Value,
    cwd: &str,
    singular: &str,
    plural: &str,
) -> napi::Result<String> {
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    for value in values(value) {
        let (uri, at) = location(value).ok_or_else(|| {
            failed(format!(
                "language server returned a malformed {singular} result"
            ))
        })?;
        let line = location_text(&uri, at, cwd);
        if seen.insert(line.clone()) {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        return Ok(format!("No {plural} found"));
    }
    let label = if lines.len() == 1 { singular } else { plural };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

fn hover_part(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let text = value.get("value")?.as_str()?;
    let language = value.get("language").and_then(Value::as_str);
    Some(language.map_or_else(
        || text.to_owned(),
        |language| format!("```{language}\n{text}\n```"),
    ))
}

pub(super) fn format_hover(value: &Value) -> napi::Result<String> {
    if value.is_null() {
        return Ok("No hover information found".to_owned());
    }
    let contents = value
        .get("contents")
        .ok_or_else(|| failed("language server returned a malformed hover result"))?;
    let mut parts = Vec::new();
    for value in values(contents) {
        let part = hover_part(value)
            .ok_or_else(|| failed("language server returned a malformed hover result"))?;
        if !part.is_empty() {
            parts.push(part);
        }
    }
    if parts.is_empty() {
        return Ok("No hover information found".to_owned());
    }
    Ok(format!("Hover information\n{}", parts.join("\n\n")))
}

const SYMBOL_KINDS: [&str; 26] = [
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "Enum member",
    "Struct",
    "Event",
    "Operator",
    "Type parameter",
];

fn symbol_kind(value: &Value) -> Option<String> {
    let kind = value.as_u64()?;
    if kind == 0 {
        return None;
    }
    Some(
        SYMBOL_KINDS
            .get(kind as usize - 1)
            .map_or_else(|| format!("Symbol {kind}"), |value| (*value).to_owned()),
    )
}

fn symbol_lines(
    value: &Value,
    cwd: &str,
    fallback_uri: &str,
    depth: usize,
) -> napi::Result<Vec<String>> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
    let kind = value
        .get("kind")
        .and_then(symbol_kind)
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
    let at = value
        .get("selectionRange")
        .and_then(range)
        .or_else(|| value.get("range").and_then(range));
    let (uri, at) = if let Some(at) = at {
        (fallback_uri.to_owned(), at)
    } else {
        location(
            value
                .get("location")
                .ok_or_else(|| failed("language server returned a malformed symbol result"))?,
        )
        .ok_or_else(|| failed("language server returned a malformed symbol result"))?
    };
    let detail = value
        .get("detail")
        .or_else(|| value.get("containerName"))
        .and_then(Value::as_str)
        .map(|detail| format!(" — {detail}"))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "{}{} · {kind} · {name}{detail}",
        "  ".repeat(depth),
        location_text(&uri, at, cwd)
    )];
    if let Some(children) = value.get("children") {
        let children = children
            .as_array()
            .ok_or_else(|| failed("language server returned a malformed symbol result"))?;
        for child in children {
            lines.extend(symbol_lines(child, cwd, fallback_uri, depth + 1)?);
        }
    }
    Ok(lines)
}

pub(super) fn format_symbols(value: &Value, cwd: &str, fallback_uri: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in values(value) {
        lines.extend(symbol_lines(value, cwd, fallback_uri, 0)?);
    }
    if lines.is_empty() {
        return Ok("No symbols found".to_owned());
    }
    let label = if lines.len() == 1 {
        "symbol"
    } else {
        "symbols"
    };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

pub(super) fn first_item(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(values) => values.first().cloned(),
        value => Some(value.clone()),
    }
}

fn call_item(value: &Value) -> Option<CallItem> {
    let name = value.get("name")?.as_str()?.to_owned();
    let uri = value.get("uri")?.as_str()?.to_owned();
    let at = range(value.get("selectionRange")?)?;
    range(value.get("range")?)?;
    let kind = symbol_kind(value.get("kind")?)?;
    Some((name, kind, uri, at))
}

pub(super) fn format_calls(value: &Value, cwd: &str, direction: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in values(value) {
        let target = if direction == "incoming" {
            value.get("from")
        } else {
            value.get("to")
        }
        .and_then(call_item)
        .ok_or_else(|| failed("language server returned a malformed call hierarchy result"))?;
        lines.push(format!(
            "{} · {} · {}",
            location_text(&target.2, target.3, cwd),
            target.1,
            target.0
        ));
    }
    if lines.is_empty() {
        return Ok(format!("No {direction} calls found"));
    }
    let label = if lines.len() == 1 { "call" } else { "calls" };
    Ok(bounded(
        format!("Found {} {direction} {label}", lines.len()),
        lines,
    ))
}

pub(super) fn format_diagnostics(items: &[Value], uri: &str, cwd: &str) -> napi::Result<String> {
    let mut lines = Vec::new();
    for value in items {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| failed("language server returned a malformed diagnostic result"))?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let message = if message.is_empty() {
            "(empty message)".to_owned()
        } else {
            message
        };
        let at = value
            .get("range")
            .and_then(range)
            .ok_or_else(|| failed("language server returned a malformed diagnostic result"))?;
        let severity = match value.get("severity").and_then(Value::as_u64) {
            Some(1) => "error",
            Some(2) => "warning",
            Some(3) => "information",
            Some(4) => "hint",
            _ => "diagnostic",
        };
        let source = value.get("source").and_then(Value::as_str);
        let code = value.get("code").and_then(|code| {
            code.as_str()
                .map(str::to_owned)
                .or_else(|| code.as_i64().map(|value| value.to_string()))
                .or_else(|| {
                    code.get("value").and_then(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .or_else(|| value.as_i64().map(|value| value.to_string()))
                    })
                })
        });
        let label = [source.map(str::to_owned), code]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let label = if label.is_empty() {
            String::new()
        } else {
            format!(" [{label}]")
        };
        lines.push(format!(
            "{}: {severity}{label}: {message}",
            location_text(uri, at, cwd)
        ));
    }
    if lines.is_empty() {
        return Ok("No diagnostics found".to_owned());
    }
    let label = if lines.len() == 1 {
        "diagnostic"
    } else {
        "diagnostics"
    };
    Ok(bounded(format!("Found {} {label}", lines.len()), lines))
}

#[cfg(test)]
mod tests {
    use super::{format_diagnostics, format_hover, format_locations};
    use serde_json::json;

    #[test]
    fn formats_locations_and_hover() {
        let value = json!({
            "uri": "file:///tmp/a.ts",
            "range": {
                "start": { "line": 0, "character": 1 },
                "end": { "line": 0, "character": 2 }
            }
        });
        assert_eq!(
            format_locations(&value, "/tmp", "definition", "definitions").unwrap(),
            "Found 1 definition\na.ts:1:2-1:3"
        );
        assert_eq!(
            format_hover(&json!({ "contents": "hello" })).unwrap(),
            "Hover information\nhello"
        );
    }

    #[test]
    fn formats_diagnostic() {
        let items = vec![json!({
            "range": {
                "start": { "line": 1, "character": 2 },
                "end": { "line": 1, "character": 3 }
            },
            "severity": 1,
            "message": "bad"
        })];
        assert_eq!(
            format_diagnostics(&items, "file:///tmp/a.ts", "/tmp").unwrap(),
            "Found 1 diagnostic\na.ts:2:3-2:4: error: bad"
        );
    }
}
