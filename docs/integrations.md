# Integrations

Connect Xal to local usage dashboards, language servers for semantic code intelligence, and MCP servers for external tools, resources, and prompts.

## Local usage dashboards

Xal writes one prompt-free usage record after each provider request that reports token counts. Records are JSONL files under `$XAL_HOME/usage/`, or `~/.xal/usage/` by default. Each Xal process owns a separate file so concurrent sessions never contend for the same log.

```json
{
  "type": "provider_usage",
  "version": 1,
  "id": "…",
  "timestamp": "2026-08-22T12:34:56.000Z",
  "provider": "openai-chatgpt",
  "model": "gpt-5.6-sol",
  "phase": "turn",
  "outcome": "completed",
  "usage": { "totalInputTokens": 120, "cacheReadInputTokens": 80, "cacheWriteInputTokens": 0, "outputTokens": 15 }
}
```

`totalInputTokens` includes cached input. The cache-read and cache-write fields identify the subsets that may be priced differently. `outputTokens` is the provider-reported output total. `phase` distinguishes normal turns, compaction, goal evaluation, and normal-mode permission classification requests. Permission classification records use `permission_classification`. `outcome` preserves requests that reported billable usage before failing or being interrupted. Records never contain provider prompts, classifier context, tool arguments, verdict reasons, paths, profile IDs, or credentials.

The ledger contains no prompts, responses, working directories, profile names, credentials, or account identifiers. Files and directories are created with user-only permissions. Xal flushes pending records during shutdown and exits with an error if the ledger could not be written. Existing session transcripts are not backfilled, so collection starts with the first run of a Xal version that supports the ledger.

Usage dashboards should read this native ledger instead of treating Xal as Codex or asking Xal to write into another tool's home directory. The `provider` field lets a dashboard attribute ChatGPT usage to Codex, Anthropic usage to Claude, xAI usage to Grok, and other supported providers without coupling to Xal's full session format.

## Language servers

Xal includes lazy language-server recipes for common languages:

| ID           | File suffixes                                                | Command                      | Installation                                                 |
| ------------ | ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | `typescript-language-server` | `npm install --global typescript-language-server typescript` |
| `python`     | `.py`, `.pyi`                                                | `pyright-langserver`         | `npm install --global pyright`                               |
| `rust`       | `.rs`                                                        | `rust-analyzer`              | `rustup component add rust-analyzer`                         |
| `go`         | `.go`                                                        | `gopls`                      | `go install golang.org/x/tools/gopls@latest`                 |

Xal checks for these commands on `PATH`, but never downloads or installs them. An installed recipe remains idle until the model queries a matching file. `/lsp` reports missing commands as unavailable with their installation guidance.

### Configure servers

Configure built-in overrides and custom servers under `pluginConfig.lsp.servers`. A built-in entry inherits every omitted recipe field, and `enabled: false` disables it. Custom server names must begin with a lower-case letter and contain only lower-case letters, numbers, hyphens, and underscores.

```json
{
  "pluginConfig": {
    "lsp": {
      "servers": {
        "typescript": {
          "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
          "timeoutMs": 45000
        },
        "python": {
          "enabled": false
        },
        "lua": {
          "command": "lua-language-server",
          "fileTypes": {
            ".lua": "lua"
          },
          "rootMarkers": [".luarc.json", ".git"]
        }
      }
    }
  }
}
```

An enabled custom server requires `command` and a non-empty `fileTypes` object mapping filename suffixes to LSP language IDs. Commands must be executable names resolved through `PATH` or absolute paths. Relative executable paths are rejected because servers run from detected project roots. A suffix can belong to only one enabled server, so disable a built-in recipe before assigning its suffixes to a differently named replacement.

`args` and `env` are optional, custom `rootMarkers` default to `[".git"]`, `timeoutMs` defaults to `30000`, and `enabled` defaults to `true`. Supplying `args`, `fileTypes`, or `rootMarkers` on a built-in replaces that recipe field. `initializationOptions` are passed during the LSP handshake; `settings` are sent with `workspace/didChangeConfiguration` after initialization. `${NAME}` references in the command, arguments, and environment values expand from Xal's environment, and secret-like environment values enter its redaction set.

### Runtime behavior

The read-only `lsp` model tool supports definitions, references, hover information, document and workspace symbols, implementations, incoming and outgoing calls, and diagnostics. It starts one server lazily for each matching server and project root. Before every request, Xal reads the current file from disk and synchronizes changed content through the notifications supported by the server. The diagnostics operation uses pull diagnostics when supported and otherwise waits briefly for published diagnostics.

For each file, Xal searches upward for the nearest configured root marker. If none is found, it uses the session working directory for files inside that workspace and the file's directory for external files. `/lsp` shows disabled, unavailable, idle, ready, and failed servers. `/lsp restart [server]` closes matching instances; the next semantic query starts them again. The model-facing tool is available when at least one enabled server command resolves. Language-server commands run as trusted local processes with the server root as their working directory, so only configure executables you trust. Xal closes every started server during shutdown.

## MCP servers

MCP servers are configured under `pluginConfig.mcp.servers`. Server names must begin with a lower-case letter and contain only lower-case letters, numbers, hyphens, and underscores.

```json
{
  "pluginConfig": {
    "mcp": {
      "servers": {
        "local-tools": {
          "transport": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/server.js"],
          "cwd": "/absolute/path/to/project",
          "env": {
            "SERVICE_TOKEN": "${SERVICE_TOKEN}"
          },
          "timeoutMs": 30000
        },
        "remote-tools": {
          "transport": "http",
          "url": "https://example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${MCP_TOKEN}"
          }
        }
      }
    }
  }
}
```

Each server supports `enabled`, which defaults to `true`, and `timeoutMs`, which defaults to `30000`. A stdio server requires `command`, accepts optional `args`, `cwd`, and `env`, and inherits Xal's process environment with the configured values applied. Relative `cwd` values resolve from the directory where Xal starts. Xal bounds stdio messages, captures recent server stderr for failures, and terminates the server process tree during shutdown. An HTTP server requires `url` and accepts optional `headers`; Xal tries Streamable HTTP first and falls back to legacy SSE at the same URL only when the initial Streamable HTTP request receives a 4xx response. HTTP redirects are rejected so authorization and custom headers cannot be replayed to another destination, and response bodies and SSE events are size-bounded.

If a higher-priority configuration changes an existing server's transport, fields inherited for the inactive transport are ignored. Unknown field names still fail configuration.

`${NAME}` references in commands, arguments, working directories, environment values, URLs, and headers expand from Xal's environment. A missing variable makes the MCP configuration fail instead of starting with an incomplete value. Values in secret-like environment variables and headers are added to Xal's redaction set.

### Project `.mcp.json` discovery

On an interactive launch, Xal checks for `.mcp.json` at the detected project root after the workspace is trusted and before plugins or the session start. The file uses the common `mcpServers` object:

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

The `type` field may be omitted for stdio servers. `http` and `streamable-http` both import as Xal's HTTP transport. Stdio entries accept `command`, `args`, `cwd`, `env`, `enabled`, and `timeoutMs`. HTTP entries accept `url`, `headers`, `enabled`, and `timeoutMs`. Names follow the same lower-case rules as native Xal MCP configuration. Unknown fields and malformed values fail startup.

When the file contains names that are not already configured in Xal, the launch chooser offers four actions:

- **Use for this session** adds the new servers only to the current Xal process.
- **Add to this project** copies the new definitions into `<git-root>/.<name>/config.json`.
- **Add globally** copies the new definitions into `<app-home>/config.json`.
- **Do not use** rejects them for this launch. Xal asks again on the next interactive launch.

Existing Xal server names always win and are never overwritten by `.mcp.json`. After every discovered name has been imported, Xal does not prompt again. Environment references are copied without expansion so secrets are not written into configuration. Noninteractive commands do not use unapproved discovered servers and print a message explaining how to approve them interactively.

### MCP runtime behavior

Servers connect in parallel during plugin bootstrap. One unavailable server is reported as failed without hiding capabilities from healthy servers. MCP tool definitions and server instructions are deferred instead of sending every remote method and operating guide to the model up front. The model receives `mcp_tool_search`, which searches cached tool metadata and loads only matching definitions for its next call. That next request also includes system instructions from the servers that own those matches. Loaded tools use names such as `mcp__local-tools__count`, retain their remote input schemas, and remain available for that session. Remote MCP calls pass through normal permission handling and run without confirmation in normal mode unless an explicit permission rule asks or denies them. They are still treated as unsandboxed mutations and invalidate workspace redo history because server annotations are untrusted hints and the tool's effects are external or unknown. Reading a remote resource or resolving a remote prompt follows the same policy; listing their already-cached catalogs remains read-only.

Connected resource catalogs, resource templates, and prompts are exposed through `mcp_resources`, `mcp_read_resource`, `mcp_prompts`, and `mcp_get_prompt`. Binary resource and image or audio content is summarized with its media type and byte size because Xal's tool-result boundary is text-only. Catalog pagination is bounded by page count, item count, cursor size, and the server timeout. Tools whose output schema uses an unsupported dialect are skipped and reported in status. Xal does not currently advertise the MCP Tasks extension. Tools with the obsolete `execution.taskSupport: "required"` field still appear in the catalog, but calls fail if the server refuses a synchronous result because it requires Tasks support.

Tool-list change notifications refresh registered tools, and `/mcp reconnect [server]` reconnects one server or all servers. Run `/mcp` to open a searchable server list with transport, status, and capability counts. Selecting a server offers reconnect and delete actions. Delete requires confirmation, disconnects the server, unregisters its tools, and removes its definition from the project or global Xal configuration file that supplied it. A session-only discovered server is removed only from the current process. If deleting a project override reveals a same-name global definition, that global server becomes effective on the next launch.
