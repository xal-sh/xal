pub const HEADER_SESSION_ID: &str = "Mcp-Session-Id";
pub const HEADER_LAST_EVENT_ID: &str = "Last-Event-Id";
pub const HEADER_MCP_PROTOCOL_VERSION: &str = "MCP-Protocol-Version";
pub const EVENT_STREAM_MIME_TYPE: &str = "text/event-stream";
pub const JSON_MIME_TYPE: &str = "application/json";

// SEP-2243 standard headers, gated on protocol version >= 2026-07-28.
pub const HEADER_MCP_METHOD: &str = "Mcp-Method";
pub const HEADER_MCP_NAME: &str = "Mcp-Name";
pub const HEADER_MCP_PARAM_PREFIX: &str = "Mcp-Param-";

/// Sentinel wrapping a Base64-encoded SEP-2243 header value (`=?base64?<b64>?=`).
pub const BASE64_HEADER_PREFIX: &str = "=?base64?";
pub const BASE64_HEADER_SUFFIX: &str = "?=";

/// Reserved headers that must not be overridden by user-supplied custom headers.
/// `MCP-Protocol-Version` is in this list but is allowed through because the worker
/// injects it after initialization.
#[allow(dead_code)]
pub(crate) const RESERVED_HEADERS: &[&str] = &[
    "accept",
    HEADER_SESSION_ID,
    HEADER_MCP_PROTOCOL_VERSION, // allowed through by validate_custom_header; worker injects it post-init
    HEADER_LAST_EVENT_ID,
];

/// Checks whether a custom header name is allowed.
/// Returns `Ok(())` if allowed, `Err(name)` if rejected as reserved.
/// `MCP-Protocol-Version` is reserved but allowed through (the worker injects it post-init).
#[cfg(feature = "client-side-sse")]
pub(crate) fn validate_custom_header(name: &http::HeaderName) -> Result<(), String> {
    if RESERVED_HEADERS
        .iter()
        .any(|&r| name.as_str().eq_ignore_ascii_case(r))
    {
        if name
            .as_str()
            .eq_ignore_ascii_case(HEADER_MCP_PROTOCOL_VERSION)
        {
            return Ok(());
        }
        return Err(name.to_string());
    }
    Ok(())
}

/// Extracts the `scope=` parameter from a `WWW-Authenticate` header value.
/// Handles both quoted (`scope="files:read files:write"`) and unquoted (`scope=read:data`) forms.
#[cfg(feature = "client-side-sse")]
pub(crate) fn extract_scope_from_header(header: &str) -> Option<String> {
    let lowercase = header.to_ascii_lowercase();
    let bytes = lowercase.as_bytes();
    let mut in_quotes = false;
    let mut escaped = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_quotes {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_quotes = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_quotes = true;
            index += 1;
            continue;
        }
        let boundary = index == 0
            || matches!(bytes[index - 1], b',' | b';')
            || bytes[index - 1].is_ascii_whitespace();
        if !boundary || !bytes[index..].starts_with(b"scope=") {
            index += 1;
            continue;
        }
        let start = index + b"scope=".len();
        let value = &header[start..];
        if let Some(quoted) = value.strip_prefix('"') {
            let mut escaped = false;
            for (end, character) in quoted.char_indices() {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    return Some(quoted[..end].to_owned());
                }
            }
            return None;
        }
        let end = value
            .find(|character: char| {
                character == ',' || character == ';' || character.is_whitespace()
            })
            .unwrap_or(value.len());
        return (end > 0).then(|| value[..end].to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "client-side-sse")]
    use super::*;

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn extract_scope_quoted() {
        let header = r#"Bearer error="insufficient_scope", scope="files:read files:write""#;
        assert_eq!(
            extract_scope_from_header(header),
            Some("files:read files:write".to_string())
        );
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn extract_scope_unquoted() {
        let header = r#"Bearer scope=read:data, error="insufficient_scope""#;
        assert_eq!(
            extract_scope_from_header(header),
            Some("read:data".to_string())
        );
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn extract_scope_missing() {
        let header = r#"Bearer error="invalid_token""#;
        assert_eq!(extract_scope_from_header(header), None);
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn extract_scope_ignores_other_parameters_and_quoted_values() {
        assert_eq!(extract_scope_from_header("Bearer custom_scope=admin"), None);
        assert_eq!(
            extract_scope_from_header(
                r#"Bearer error_uri="https://idp.test?scope=admin", scope="files:read""#,
            ),
            Some("files:read".to_owned())
        );
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn extract_scope_empty_header() {
        assert_eq!(extract_scope_from_header("Bearer"), None);
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn validate_rejects_reserved_accept() {
        let name = http::HeaderName::from_static("accept");
        assert!(validate_custom_header(&name).is_err());
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn validate_rejects_reserved_session_id() {
        let name = http::HeaderName::from_static("mcp-session-id");
        assert!(validate_custom_header(&name).is_err());
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn validate_allows_mcp_protocol_version() {
        let name = http::HeaderName::from_static("mcp-protocol-version");
        assert!(validate_custom_header(&name).is_ok());
    }

    #[cfg(feature = "client-side-sse")]
    #[test]
    fn validate_allows_custom_header() {
        let name = http::HeaderName::from_static("x-custom");
        assert!(validate_custom_header(&name).is_ok());
    }
}
