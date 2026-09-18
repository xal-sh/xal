# Configuration

Configure Xal globally for your user or locally for one project. This page explains configuration files, merge behavior, and the top-level schema. Follow the links in the option table for detailed behavior and examples.

## File locations

The app name comes from `apps/cli/package.json`. In the paths and commands below, `<name>` means that package name. The app home defaults to `~/.<name>` and can be overridden with the environment variable formed by upper-casing the package name, replacing non-alphanumeric characters with underscores, and appending `_HOME`.

Xal reads JSON configuration from two locations:

| Layer   | Path                             | Priority |
| ------- | -------------------------------- | -------- |
| User    | `<app-home>/config.json`         | Lower    |
| Project | `<git-root>/.<name>/config.json` | Higher   |

Xal searches upward from the working directory for `.git`. When no Git root is found, the working directory is used as the project root.

Both files are optional and must contain a JSON object when present. Objects merge recursively from user to project configuration. Arrays and scalar values are replaced by the project value. Project configuration applies to every option, including plugins and permission rules, so it must be treated as trusted code and policy.

A project-root `.mcp.json` is a discovery source rather than a third configuration layer. On interactive launch, Xal can use its new MCP server names for the current process or copy them into either configuration file. Existing Xal server names are not overwritten. See [Project `.mcp.json` discovery](/docs/integrations#project-mcpjson-discovery) for the accepted schema and launch choices.

Commands that save model, thinking, context-window, compaction-limit, compaction strategy, or TUI display preferences write the user file. Xal then recomputes the effective configuration, and any project override remains active. Importing discovered MCP servers and deleting servers from `/mcp` are source-aware exceptions: project choices update the project file, global choices update the user file, and deletion updates the file that supplied the effective server.

Global memory is stored at `<app-home>/MEMORY.md`. On Unix, Xal creates it with mode `0600` and rejects broader permissions. Windows does not expose an equivalent mode through the filesystem API, so Xal relies on the inherited ACL of `<app-home>`. If the app home is overridden on Windows, its directory must be private to the current user.

## Top-level options

| Option             | Type       | Default                     | Details                                                                     |
| ------------------ | ---------- | --------------------------- | --------------------------------------------------------------------------- |
| `plugins`          | `string[]` | `[]`                        | Additional modules described in [Plugins and hooks](/docs/plugins).         |
| `provider`         | `string`   | Last registered provider    | Provider ID or alias used for new sessions.                                 |
| `profile`          | `string`   | Selected connection         | Internal ID of the named provider profile used for new sessions.            |
| `model`            | `string`   | Provider default            | Model ID used for new sessions.                                             |
| `ui`               | `string`   | `"tui"`                     | UI ID started when Xal runs without a command.                              |
| `mode`             | `string`   | `"normal"`                  | Permission mode used for new TUI and headless sessions.                     |
| `permissions`      | `object`   | `{}`                        | Global rules described in [Permissions and security](/docs/permissions).    |
| `modes`            | `object`   | `{}`                        | [Custom permission modes](/docs/permissions#custom-modes) keyed by name.    |
| `goal`             | `object`   | `{}`                        | Evaluator models described in [Goals](/docs/goals).                         |
| `redaction`        | `object`   | `{}`                        | [Sensitive values](/docs/permissions#redaction) to redact.                  |
| `agents`           | `object`   | `{}`                        | Limits described in [Background work](/docs/background-work#configuration). |
| `pluginConfig`     | `object`   | `{}`                        | Configuration keyed by plugin name.                                         |
| `thinking`         | `object`   | `{}`                        | Thinking effort keyed by provider ID and model ID.                          |
| `contextWindows`   | `object`   | `{}`                        | Context-window choices keyed by provider ID and model ID.                   |
| `compaction`       | `object`   | `{ "strategy": "summary" }` | Optional [Jev compaction](#jev-compaction).                                 |
| `compactionLimits` | `object`   | `{}`                        | Auto-compaction limits keyed by provider ID and model ID.                   |
| `codeSearch`       | `object`   | `{ "strategy": "off" }`     | Optional [Jev code search](#jev-code-search).                               |

The `profile` value is managed by `/connect` and `/model`. Profile names remain user-facing and may be renamed without changing this ID.

`mode` accepts `normal`, `plan`, `yolo`, or a name defined under `modes`. A command-line `--mode` overrides the configured default for that session.

Malformed `mode`, `permissions`, `modes`, `goal`, `redaction`, `compaction`, or `agents` configuration fails startup instead of silently running without those rules.

Built-in configuration is documented with the feature that consumes it:

- [TUI](/docs/tui) covers display preferences and keybindings.
- [Integrations](/docs/integrations) covers language servers and MCP servers.
- [Providers and models](/docs/providers) covers built-in provider options and model discovery.
- [Plugins and hooks](/docs/plugins) covers custom plugin configuration.
- [Commands and skills](/docs/commands-and-skills) covers project instruction limits.
- [Scheduler](/docs/scheduler) covers delayed model continuation.

## Thinking effort

Thinking preferences use this shape:

```json
{
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    },
    "deepseek": {
      "deepseek-v4-flash": "max"
    }
  }
}
```

Supported effort values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Each provider and model may support only a subset. An unavailable saved effort is ignored in favor of that model's default.

## Context windows

Context-window preferences use the same provider and model keys:

```json
{
  "contextWindows": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 600000
    },
    "openai": {
      "gpt-5.6-sol": 1000000
    }
  }
}
```

Use `/context-window` to save this preference for the current model. The command is available when a provider advertises multiple windows. Provider entries must be objects, and each model value must be a positive integer. A saved value that is no longer offered is ignored in favor of the model default.

## Compaction limits

Automatic-compaction preferences use fixed token counts for each provider and canonical model:

```json
{
  "compactionLimits": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 180000
    },
    "anthropic": {
      "claude-opus-4-6": 140000
    }
  }
}
```

Use `/compaction-limit` to choose a context-relative limit for the active model. The command offers fixed token values at 50%, 60%, 70%, and 80% of the active context window and saves the selected absolute value under the canonical model ID. It is available only when the model has a known context window.

Provider entries must be objects, and each model value must be a positive integer. A saved value takes precedence over a provider-advertised limit, but every effective limit is capped at 80% of the active context window. This cap also keeps a stale value safe when `/context-window` changes the model's active window.

## Jev compaction

Jev pruning is disabled by default. After connecting TypeSafe, run `/config`, choose **Compaction**, and select **Jev · <profile>**. `/config compaction` opens that selector directly. Only connected TypeSafe profiles are offered. Choose **Summary compaction** to disable it. If the selected profile is later removed, the selector remains available so you can disable or replace it.

```json
{
  "compaction": {
    "strategy": "jev",
    "profile": "<immutable TypeSafe profile ID>"
  }
}
```

`strategy` accepts `summary` (default) or `jev`. `jev` requires a non-empty `profile` ID, not the profile name or token. Unknown options or malformed strategy settings fail startup. UI changes write the user config; a trusted project override still takes precedence. The setting applies to manual `/compact` and automatic compaction, including task-agent sessions. It does not change the existing `compactionLimits` trigger.

Enabling this sends structured state to TypeSafe's `jev-latest` with `context`, `goal`, and `history`. The context explains that pruning frees space for the assistant to continue its task while preserving requirements, decisions, and information needed for unfinished work. The goal is the explicit `/compact` focus when non-empty; otherwise it uses the last three non-empty user prompts in chronological order, each limited to 500 UTF-8 bytes with an omission marker when shortened. History contains an indexed text view of the active conversation, tool names and inputs. Tool results are represented by their lengths, images by omission notices, and opaque provider replay data is excluded. Long inputs and older text may be shortened in the decision view only. Xal conservatively targets 25,000 estimated state tokens and 30,000 estimated total tokens per request, batching questions as needed. Every batch receives the same context, goal, and fitted history. These are estimates, not a tokenizer guarantee.

Jev scores whether older tool calls and their results should stay. A result probability of at least 0.5 keeps both; otherwise a call probability of at least 0.5 keeps the call and truncates long results to 300 characters plus a notice; otherwise both are removed. The first conversation item and the newest six items are protected, including either half of any tool pair touching those items. User and assistant text, images, and retained provider replay data remain unchanged in the saved history. The `jev_v1` checkpoint reloads that history without adding a synthetic summary.

Pruning is accepted only when it reduces the estimated full harness request by more than 25% and leaves it below 90% of the active auto-compaction limit, when known. Unavailable credentials, API errors, invalid decisions, an oversized decision view, or insufficient reduction produce a visible fallback notice, then run ordinary summary compaction against the original history. No partial Jev edits are applied. User cancellation stops without fallback or history replacement. The whole Jev attempt is bounded to 60 seconds. Successful decision requests are included in TypeSafe's compaction token usage.

This is inspired by [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), adapted to Xal's conversation and persistence contracts without importing its Claude-specific message format.

## Jev code search

Code search is disabled by default and is independent of compaction. Connect TypeSafe, then run `/config`, choose **Code search**, and select **Jev · <profile>**. `/config code-search` opens the selector directly. Choose **Code search off** to disable it. The selector remains available if an enabled profile is disconnected.

```json
{
  "codeSearch": {
    "strategy": "jev",
    "profile": "<immutable TypeSafe profile ID>"
  }
}
```

`strategy` accepts `off` (default) or `jev`. `jev` requires a non-empty profile ID, not a profile name or API key. Unknown fields or invalid settings fail startup. UI changes save to user configuration; a trusted project override still takes precedence. This enables the read-only `code_search` tool in primary and task-agent sessions without changing the harness model.

**Privacy:** enabling this allows search queries, relative file paths, and shortlisted source excerpts to be sent to TypeSafe. It does not upload an index or the entire workspace. Requests use the existing secret redactor, which protects known values, not every possible secret. File exclusions are defense in depth, not a guarantee that source files contain no secrets. Only enable it for code you can send to TypeSafe. Use `code_search` permission rules to control tool access.

See [semantic code search](/docs/integrations#semantic-code-search) for retrieval limits, ranking, fallback behavior, and examples.

## Combined example

Every option is optional. This example shows how the top-level sections fit together. Each linked feature page documents its complete nested schema.

```json
{
  "plugins": ["/absolute/path/to/example-plugin"],
  "provider": "openai-chatgpt",
  "model": "gpt-5.6-terra",
  "ui": "tui",
  "mode": "normal",
  "permissions": {
    "allow": ["bash(git status*)"],
    "ask": ["bash(git push*)"],
    "deny": ["bash(rm -rf /*)"]
  },
  "modes": {
    "paranoid": { "ask": ["*"] }
  },
  "goal": {
    "evaluatorModels": {
      "openai-chatgpt": "gpt-5.6-terra"
    }
  },
  "redaction": {
    "environment": ["MY_PROJECT_TOKEN"]
  },
  "agents": {
    "maxConcurrent": 4,
    "timeoutMinutes": 0,
    "maxTurns": 24
  },
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    }
  },
  "contextWindows": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 600000
    }
  },
  "compactionLimits": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 180000
    }
  },
  "pluginConfig": {
    "tui": {
      "showOutputs": false,
      "showThinking": false,
      "scrollbackRows": 1000
    },
    "project-instructions": {
      "maxBytes": 65536
    },
    "example-plugin": {
      "enabled": true
    }
  }
}
```
