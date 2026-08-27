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

Commands that save model, thinking, context-window, or TUI display preferences write the user file. Xal then recomputes the effective configuration, and any project override remains active. Importing discovered MCP servers and deleting servers from `/mcp` are source-aware exceptions: project choices update the project file, global choices update the user file, and deletion updates the file that supplied the effective server.

Global memory is stored at `<app-home>/MEMORY.md`. On Unix, Xal creates it with mode `0600` and rejects broader permissions. Windows does not expose an equivalent mode through the filesystem API, so Xal relies on the inherited ACL of `<app-home>`. If the app home is overridden on Windows, its directory must be private to the current user.

## Top-level options

| Option           | Type       | Default                  | Details                                                                     |
| ---------------- | ---------- | ------------------------ | --------------------------------------------------------------------------- |
| `plugins`        | `string[]` | `[]`                     | Additional modules described in [Plugins and hooks](/docs/plugins).         |
| `provider`       | `string`   | Last registered provider | Provider ID or alias used for new sessions.                                 |
| `profile`        | `string`   | Selected connection      | Internal ID of the named provider profile used for new sessions.            |
| `model`          | `string`   | Provider default         | Model ID used for new sessions.                                             |
| `ui`             | `string`   | `"tui"`                  | UI ID started when Xal runs without a command.                              |
| `mode`           | `string`   | `"normal"`               | Permission mode used for new TUI and headless sessions.                     |
| `permissions`    | `object`   | `{}`                     | Global rules described in [Permissions and security](/docs/permissions).    |
| `modes`          | `object`   | `{}`                     | [Custom permission modes](/docs/permissions#custom-modes) keyed by name.    |
| `goal`           | `object`   | `{}`                     | Evaluator models described in [Goals](/docs/goals).                         |
| `redaction`      | `object`   | `{}`                     | [Sensitive values](/docs/permissions#redaction) to redact.                  |
| `agents`         | `object`   | `{}`                     | Limits described in [Background work](/docs/background-work#configuration). |
| `pluginConfig`   | `object`   | `{}`                     | Configuration keyed by plugin name.                                         |
| `thinking`       | `object`   | `{}`                     | Thinking effort keyed by provider ID and model ID.                          |
| `contextWindows` | `object`   | `{}`                     | Context-window choices keyed by provider ID and model ID.                   |

The `profile` value is managed by `/connect` and `/model`. Profile names remain user-facing and may be renamed without changing this ID.

`mode` accepts `normal`, `plan`, `yolo`, or a name defined under `modes`. A command-line `--mode` overrides the configured default for that session.

Malformed `mode`, `permissions`, `modes`, `goal`, `redaction`, or `agents` configuration fails startup instead of silently running without those rules.

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

Use `/context-window` to save this preference for the current model. The command is available when a provider advertises multiple windows. A saved value that is no longer offered is ignored in favor of the model default.

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
    "timeoutMinutes": 10,
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
