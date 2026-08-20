# Xal rmcp patch

This is rmcp 3.1.4 under Apache-2.0, vendored from https://github.com/modelcontextprotocol/rust-sdk.

The only source change adds preservation of `Tool.execution` during MCP catalog deserialization. Upstream 3.1.4 discards that protocol field, which prevents Xal from excluding tools whose `taskSupport` is `required`.
