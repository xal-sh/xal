# Xal rmcp patch

This is rmcp 3.1.4 under Apache-2.0, vendored from https://github.com/modelcontextprotocol/rust-sdk.

Xal preserves `Tool.execution` during MCP catalog deserialization because upstream 3.1.4 discards that protocol field, which prevents Xal from excluding tools whose `taskSupport` is `required`. The vendored copy also carries focused transport, routing, and model fixes needed by Xal and omits upstream build and test metadata whose referenced files are not included in this snapshot.

The response cache's `max_entries: 0` setting is intentionally unbounded. When `serve_stale_on_error` is also enabled, one response per unique cache key remains available until the cache is cleared or its peer is dropped. Callers that need bounded memory must use a nonzero `max_entries` value.
