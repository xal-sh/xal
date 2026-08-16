# Configuration

The app name comes from `apps/cli/package.json`. In the paths and commands below, `<name>` means that package name. The app home defaults to `~/.<name>` and can be overridden with the environment variable formed by upper-casing the package name, replacing non-alphanumeric characters with underscores, and appending `_HOME`.

The app reads JSON configuration from two locations:

| Layer   | Path                             | Priority |
| ------- | -------------------------------- | -------- |
| User    | `<app-home>/config.json`         | Lower    |
| Project | `<git-root>/.<name>/config.json` | Higher   |

The app searches upward from the working directory for `.git`. When no Git root is found, the working directory is used as the project root.

Both files are optional and must contain a JSON object when present. Objects merge recursively from user to project configuration. Arrays and scalar values are replaced by the project value. Project configuration currently applies to every option, including plugins and permission rules, so it must be treated as trusted code and policy.

Commands that save model, thinking, or TUI display preferences write the user file. The effective configuration is then recomputed, and any project override remains active.

## Options

| Option         | Type       | Default                  | Description                                                                               |
| -------------- | ---------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `plugins`      | `string[]` | `[]`                     | Additional plugins loaded after built-in plugins.                                         |
| `provider`     | `string`   | Last registered provider | Provider ID or alias used for new sessions.                                               |
| `model`        | `string`   | Provider default         | Model ID used for new sessions. Run `<name> models` to refresh and list available models. |
| `ui`           | `string`   | `"tui"`                  | UI ID started when the app is run without a command.                                      |
| `permissions`  | `object`   | `{}`                     | Permission rules under `allow`, `ask`, and `deny`.                                        |
| `modes`        | `object`   | `{}`                     | Custom permission modes keyed by mode name.                                               |
| `redaction`    | `object`   | `{}`                     | Sensitive values to redact under `values` and `environment`.                              |
| `agents`       | `object`   | `{}`                     | Task-agent limits under `maxConcurrent`, `timeoutMinutes`, and `maxTurns`.                |
| `pluginConfig` | `object`   | `{}`                     | Configuration keyed by plugin name.                                                       |
| `thinking`     | `object`   | `{}`                     | Thinking effort keyed by provider ID and then model ID.                                   |

Malformed `permissions`, `modes`, `redaction`, or `agents` configuration fails startup instead of silently running without those rules.

Built-in provider IDs are `openai-chatgpt`, `deepseek`, and `alibaba-cloud`. `chatgpt` is an alias for `openai-chatgpt`, and `dashscope` is an alias for `alibaba-cloud`. The only built-in UI ID is `tui`. Plugins may register more providers, aliases, and UIs.

### Agents

The `agents` object bounds background task agents dispatched with the `task` tool. Every field is an integer and is validated strictly.

| Option           | Default | Range   | Description                                                                                  |
| ---------------- | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `maxConcurrent`  | `4`     | `1–8`   | Task agents running at once; further dispatched tasks queue until a slot frees.              |
| `timeoutMinutes` | `10`    | `1–60`  | Hard deadline per task agent.                                                                |
| `maxTurns`       | `24`    | `1–100` | Soft turn budget; past it the agent is told to wrap up, and at 1.5× its last report is used. |

See [Background work](/docs/background-work) for how task agents and background jobs behave.

### TUI keybindings

Application shortcuts can be replaced under `pluginConfig.tui.keybindings`. Each action accepts an ordered array of bindings. The array replaces that action's defaults, and an empty array disables the action. Restart the app after changing the configuration.

```json
{
  "pluginConfig": {
    "tui": {
      "keybindings": {
        "composer.external-editor": ["ctrl+e"],
        "display.clear": ["ctrl+l", "ctrl+k"],
        "display.toggle-todos": [],
        "agents.stop-all": ["ctrl+x ctrl+s"]
      }
    }
  }
}
```

A binding is a key with optional `ctrl`, `alt`, `shift`, or `super` modifiers joined by `+`. Separate strokes with a space to form a sequence. `control`, `meta`, `option`, `cmd`, and `command` are accepted aliases. Key and modifier names are case-insensitive.

| Action                     | Default bindings                     |
| -------------------------- | ------------------------------------ |
| `agents.open`              | `ctrl+x ctrl+a`                      |
| `agents.stop-all`          | `ctrl+x ctrl+k`                      |
| `app.cancel`               | `ctrl+c`                             |
| `composer.clear`           | `ctrl+u`                             |
| `composer.external-editor` | `ctrl+g`                             |
| `composer.newline`         | `shift+enter`, `alt+enter`, `ctrl+j` |
| `composer.paste-image`     | `ctrl+v`                             |
| `display.clear`            | `ctrl+l`                             |
| `display.toggle-details`   | `ctrl+o`                             |
| `display.toggle-todos`     | `ctrl+t`                             |
| `history.open`             | `escape escape`, `ctrl+r`            |
| `jobs.background`          | `ctrl+b`                             |
| `session.next-mode`        | `shift+tab`                          |
| `thinking.decrease`        | `alt+,`                              |
| `thinking.increase`        | `alt+.`                              |
| `transcript.page-up`       | `pageup`                             |
| `transcript.page-down`     | `pagedown`                           |
| `transcript.start`         | `ctrl+home`                          |
| `transcript.end`           | `ctrl+end`                           |

The fullscreen TUI owns its transcript independently of the shell's main screen. Page Up and Page Down scroll the transcript and pause automatic tail following when moving into earlier output. Reaching the bottom with Page Down resumes following, and `transcript.end` returns immediately to live output. `display.clear` clears the visible application transcript while preserving startup headers, the active session, and the composer draft.

Malformed bindings, unknown actions, duplicate assignments, and bindings that are prefixes of other bindings fail startup. Popover navigation, completion selection, task-list navigation, and ordinary text editing remain component-owned and are not remapped by this setting.

### Plugins

The `plugins` array tells the app what to load; it does not install or download anything. Every referenced plugin must already exist and be resolvable when the app starts. Plugin registration is transactional: if importing, validating, or registering a plugin fails, the app records a plugin registration failure and keeps none of that plugin's contributions.

Each `plugins` entry supports one of these forms:

- An already-installed package or module specifier, passed directly to Bun's module loader.
- A relative directory beginning with `.`, resolved from the app home directory and expected to contain `plugin.ts`.
- An absolute directory expected to contain `plugin.ts`.

For example, this loads an existing local plugin:

```json
{
  "plugins": ["/absolute/path/to/my-plugin"]
}
```

The referenced directory must contain a `plugin.ts` whose default export has a `name`, a synchronous `register` function, and optionally asynchronous `bootstrap` and `shutdown` functions. Relative plugin paths are not resolved from the project directory, even when they are declared in project configuration.

Plugins can contribute slash commands with `ctx.registerCommand`. Commands known synchronously belong in `register`; commands discovered from files or services may be added during `bootstrap`, before interactive input is released.

When the UI or CLI exits, the app aborts `ctx.signal` so in-progress `bootstrap` work can stop, waits for bootstrap to settle, and then runs `shutdown` in reverse plugin order. Plugins that own child processes or network connections close them there. A dynamically discovered tool can be removed with `ctx.unregisterTool(tool)` using the same tool object that was registered.

### Hooks

Plugins register trusted in-process lifecycle hooks with `ctx.registerHook`. Hooks run in built-in/plugin configuration order, and multiple hooks for the same event run sequentially. A replacement from one hook becomes the input to the next hook.

| Handler      | Input                                       | Allowed result                                              |
| ------------ | ------------------------------------------- | ----------------------------------------------------------- |
| `prompt`     | Model-facing prompt text and image count    | Replace the text or reject the prompt                       |
| `beforeTool` | Tool name, call ID, and JSON arguments      | Replace the arguments or block the call                     |
| `afterTool`  | Tool details and its model-facing output    | Replace the output                                          |
| `turnEnd`    | Final output and token usage when available | No result; use it for lifecycle automation or observability |

Every handler also receives a context containing an abort signal and the session ID, kind, working directory, provider, model, and permission mode. Prompt changes affect what the model sees while the TUI keeps the user's original text. Tool argument changes happen before scheduling and permission evaluation, so the app authorizes and records the effective action. Post-tool hooks also run for failed or interrupted tool executions, but not for calls blocked before execution.

Hook failures stop prompt, pre-tool, and turn-completion processing. A post-tool failure becomes a failed tool result that warns the model the tool may already have changed state. Hook inputs and code run inside the app's process, so only load hooks you trust. Returned text and arguments pass through secret redaction before they reach the model, session storage, or TUI.

This plugin marks prompts and read results, and blocks an exact `git push` command:

```ts
export default {
  name: "visual-hooks",
  register(ctx) {
    ctx.registerHook({
      name: "marker",
      prompt(input) {
        return { type: "replace", text: `${input.text}\n\nInclude the exact marker HOOKS_ACTIVE in the answer.` }
      },
      beforeTool(input) {
        if (input.tool !== "bash" || input.args.command !== "git push") return
        return { type: "block", reason: "Publishing is disabled by the visual hook." }
      },
      afterTool(input) {
        if (input.tool !== "read") return
        return { type: "replace", output: `[visual-hooks]\n${input.output}` }
      },
    })
  },
}
```

Put the file at `plugin.ts` inside a plugin directory and add that directory's absolute path to `plugins`. In the TUI, `/hooks` lists every registered hook and the events it handles. Each completed primary-session hook invocation appears in the transcript with its action and elapsed time; task-agent hook invocations appear in that agent's job output.

### Thinking

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

### Permissions

```json
{
  "permissions": {
    "allow": ["bash(git status*)"],
    "ask": ["bash(git push*)"],
    "deny": ["bash(rm -rf /*)"]
  }
}
```

`allow`, `ask`, and `deny` are arrays of permission rules. A rule is either a tool name, such as `bash`, or a tool and subject pattern, such as `bash(git status*)` or `write(src/*)`. `*` matches any sequence of characters and also works in the tool name, so `mcp__github__*` matches every tool from that MCP server and `*` alone matches every tool. Deny rules are evaluated before all other permission rules.

### Permission modes

The app ships three modes, cycled in the TUI with the `session.next-mode` shortcut (Shift+Tab by default):

- `normal` is the default. Actions run without confirmation unless they are risky: shell commands whose file arguments, redirect targets, or `cd` destinations leave the workspace, destructive commands aimed at the workspace root or `.git`, file writes and edits outside the workspace, privileged or system-level commands such as `sudo` and `dd`, network fetches with `curl` or `wget`, force pushes, package publishes, remote MCP calls, and reads of `.env` files or key material ask first. Deletes and other file operations inside the workspace run without prompting because workspace undo can restore them. Writes to the system temporary directory are also allowed.
- `plan` is read-only. Tools that mutate anything are refused before they run.
- `yolo` converts every ask into an allow. Only deny rules still block actions.

Chained commands are evaluated per segment, so `git status && rm /etc/hosts` asks even though `git status` alone would not. Commands using substitution or grouping that cannot be split safely always ask. The built-in risky-command rules are ordinary rules, so configuration can override them: `"allow": ["bash(curl *)"]` stops `curl` from asking.

Custom modes are defined under `modes` and appear in the TUI mode cycle and `--mode`:

```json
{
  "modes": {
    "paranoid": { "ask": ["*"], "guidance": "Every action needs confirmation." },
    "trusting": { "base": "normal", "allow": ["bash(curl *)", "write(/*)"] }
  }
}
```

`base` selects the built-in mode a custom mode behaves like (`normal` by default; `plan` inherits read-only, `yolo` inherits ask-skipping). `allow`, `ask`, and `deny` are mode-scoped rules that apply only while the mode is active, sitting above the global `permissions` rules and below approvals remembered from the approval prompt. `guidance` replaces the mode instructions shown to the model. Built-in mode names cannot be redefined. A session restored with a mode that no longer exists falls back to `normal`.

### Redaction

| Option        | Type       | Default | Description                                                     |
| ------------- | ---------- | ------- | --------------------------------------------------------------- |
| `values`      | `string[]` | `[]`    | Exact sensitive values to replace.                              |
| `environment` | `string[]` | `[]`    | Environment variable names whose current values should be used. |

Matches are case-sensitive and normally become `[REDACTED]` before content reaches a model, session or prompt-history storage, tool-output artifacts, CLI output, or the TUI. The app chooses a safe alternate marker when a configured value is part of that text. Provider access tokens, refresh tokens, and API keys in the app's credential store are included automatically. Prefer `environment` for additional values so the secret itself does not need to appear in a configuration file.

Custom plugins can add values from their own credential sources with `ctx.registerSecrets`.

### Model discovery

`<name> models` and the TUI's `/model` command refresh every connected provider's model catalog. The catalog supplies the model picker, context-window tracking, input modalities, and the choices shown by `/thinking`.

The ChatGPT provider discovers the account-visible catalog from the authenticated Codex service and stores the last successful result in `<app-home>/cache/openai-chatgpt-models.json`. If live discovery is unavailable, the app reports the failure and uses that cache, then its bundled catalog. DeepSeek discovers models from its authenticated `/models` endpoint and reports when it must use bundled model metadata. Alibaba Cloud uses a bundled catalog of Qwen models shared by Model Studio and Coding Plan.

## Prompt commands

The app discovers reusable Markdown prompt commands from two directories:

| Scope   | Path                               | Priority |
| ------- | ---------------------------------- | -------- |
| User    | `<app-home>/commands/*.md`         | Lower    |
| Project | `<git-root>/.<name>/commands/*.md` | Higher   |

A project command replaces a user command with the same filename. Command filenames become slash-command names and must use lower-case letters, numbers, hyphens, or underscores. Prompt commands cannot replace built-in or plugin-registered commands.

Each file contains the prompt sent to the active session. Optional frontmatter supplies its command-palette description and argument hint:

```md
---
description: Review the current changes
argument-hint: <base-branch> [focus]
---

Review the current changes against $1. Pay particular attention to $2.

Additional context: $ARGUMENTS
```

`$1`, `$2`, and later numbered placeholders expand to positional arguments. `$ARGUMENTS` expands to all arguments joined with spaces, and `$$` emits a literal dollar sign. Missing positional arguments expand to an empty string.

After startup, type `/` in the TUI to see discovered commands in the command palette. Selecting one submits the expanded prompt through the same session path as a typed message.

## Skills

The app discovers reusable skill packages from four directories, in increasing priority:

| Scope   | Path                                    |
| ------- | --------------------------------------- |
| User    | `~/.agents/skills/**/SKILL.md`          |
| User    | `<app-home>/skills/**/SKILL.md`         |
| Project | `<git-root>/.agents/skills/**/SKILL.md` |
| Project | `<git-root>/.<name>/skills/**/SKILL.md` |

A later package replaces an earlier package with the same skill name. Project skill directories are read only after workspace trust is established.

Every package is a directory named after its skill and containing a `SKILL.md` entry file. The entry file requires YAML frontmatter with a lower-case, hyphen-separated `name` and a `description`, followed by non-empty instructions:

```md
---
name: review-changes
description: Review the current workspace changes for correctness
---

Inspect the current diff, validate every finding, and report only actionable issues.
```

Only skill names and descriptions enter the system prompt. The model loads full instructions on demand with the read-only `skill` tool, which can also read referenced text files inside that package without allowing paths to escape the package directory. `SKILL.md` files are limited to 64 KiB and supporting files read through the tool are limited to 50,000 bytes.

Type `$` anywhere in the TUI composer to open skill completion. Continue typing to filter, then press Tab, Right, or Enter to replace only the skill reference at the cursor. Known `$skill-name` references are highlighted both while editing and in the submitted user message.

A prompt beginning with `$skill-name` explicitly invokes that skill. The app keeps the compact original prompt visible in the conversation while sending the full skill instructions and the remaining user input to the model. A `$skill-name` reference later in a prompt remains ordinary user text, matching the behavior of other inline references. Skills do not register slash commands or appear in `/` completion.

## Built-in plugin configuration

### `tui`

Run `/config` in the TUI to change display preferences. Changes save immediately to the user configuration and apply to the current transcript. Both preferences default to `false`.

| Option         | Type      | Default | Description                                       |
| -------------- | --------- | ------- | ------------------------------------------------- |
| `showOutputs`  | `boolean` | `false` | Expand tool outputs and other transcript details. |
| `showThinking` | `boolean` | `false` | Include model reasoning in the transcript.        |

The TUI always emits OSC 9;4 progress while the app is working and an OSC 777 notification when a turn completes, fails, or is interrupted. Notifications include the trailing 200 characters of visible assistant output, are not gated by terminal focus, and use tmux passthrough automatically. OSC lifecycle signaling is built in and has no configuration.

The `display.toggle-details` shortcut (Ctrl+O by default) temporarily toggles transcript details for the current session without changing `showOutputs`.

### `lsp`

The app includes lazy language-server recipes for common languages:

| ID           | File suffixes                                                | Command                      | Installation                                                 |
| ------------ | ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | `typescript-language-server` | `npm install --global typescript-language-server typescript` |
| `python`     | `.py`, `.pyi`                                                | `pyright-langserver`         | `npm install --global pyright`                               |
| `rust`       | `.rs`                                                        | `rust-analyzer`              | `rustup component add rust-analyzer`                         |
| `go`         | `.go`                                                        | `gopls`                      | `go install golang.org/x/tools/gopls@latest`                 |

The app checks for these commands on `PATH`, but never downloads or installs them. An installed recipe remains idle until the model queries a matching file. `/lsp` reports missing commands as unavailable with their installation guidance.

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

An enabled custom server requires `command` and a non-empty `fileTypes` object mapping filename suffixes to LSP language IDs. Commands must be executable names resolved through `PATH` or absolute paths; relative executable paths are rejected because servers run from detected project roots. A suffix can belong to only one enabled server, so disable a built-in recipe before assigning its suffixes to a differently named replacement.

`args` and `env` are optional, custom `rootMarkers` default to `[".git"]`, `timeoutMs` defaults to `30000`, and `enabled` defaults to `true`. Supplying `args`, `fileTypes`, or `rootMarkers` on a built-in replaces that recipe field. `initializationOptions` are passed during the LSP handshake; `settings` are sent with `workspace/didChangeConfiguration` after initialization. `${NAME}` references in the command, arguments, and environment values expand from the app's environment, and secret-like environment values enter its redaction set.

The read-only `lsp` model tool supports definitions, references, hover information, document and workspace symbols, implementations, incoming and outgoing calls, and diagnostics. It starts one server lazily for each matching server and project root. Before every request, the app reads the current file from disk and synchronizes changed content through the notifications supported by the server, so changes made by any tool or external editor are visible without coupling the LSP plugin to a file-editing plugin. The diagnostics operation uses pull diagnostics when supported and otherwise waits briefly for published diagnostics.

For each file, the app searches upward for the nearest configured root marker. If none is found, it uses the session working directory for files inside that workspace and the file's directory for external files. `/lsp` shows disabled, unavailable, idle, ready, and failed servers. `/lsp restart [server]` closes matching instances; the next semantic query starts them again. The model-facing tool is available when at least one enabled server command resolves. Language-server commands run as trusted local processes with the server root as their working directory, so only configure executables you trust. The app closes every started server during shutdown.

### `mcp`

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

Each server supports `enabled` (default `true`) and `timeoutMs` (default `30000`). A stdio server requires `command`, accepts optional `args`, `cwd`, and `env`, and inherits the SDK's safe default process environment. Relative `cwd` values resolve from the directory where the app starts. An HTTP server requires `url` and accepts optional `headers`; the app tries Streamable HTTP first and falls back to legacy SSE at the same URL only when the initial Streamable HTTP request receives a 4xx response.

If a higher-priority configuration changes an existing server's transport, fields inherited for the inactive transport are ignored. Unknown field names still fail configuration.

`${NAME}` references in commands, arguments, working directories, environment values, URLs, and headers expand from the app's environment. A missing variable makes the MCP configuration fail instead of starting with an incomplete value. Values in secret-like environment variables and headers are added to the app's redaction set.

Servers connect in parallel during plugin bootstrap. One unavailable server is reported as failed without hiding tools from healthy servers. Discovered tools use names such as `mcp__local-tools__count`, retain their remote input schemas, and pass through normal permission handling. Every remote MCP call is treated as an unsandboxed mutation and invalidates workspace redo history because server annotations are untrusted hints and the tool's effects are external or unknown. Reading a remote resource or resolving a remote prompt also requires approval; listing their already-cached catalogs remains read-only.

Connected resource catalogs, resource templates, and prompts are exposed through `mcp_resources`, `mcp_read_resource`, `mcp_prompts`, and `mcp_get_prompt`. Server instructions join the system prompt. Binary resource and image or audio content is summarized with its media type and byte size because the app's tool-result boundary is text-only. Tools that require the experimental MCP task protocol, or whose output schema uses an unsupported dialect, are skipped and reported in status; ordinary and task-optional tools remain available. Tool-list change notifications refresh registered tools, and `/mcp reconnect [server]` reconnects one server or all servers. Run `/mcp` to see transport, status, and capability counts.

### `project-instructions`

| Option     | Type             | Default | Description                                                          |
| ---------- | ---------------- | ------- | -------------------------------------------------------------------- |
| `maxBytes` | Positive integer | `32768` | Maximum combined UTF-8 byte budget for discovered `AGENTS.md` files. |

### `alibaba-cloud`

| Option       | Type   | Default                                                  | Description                                                                           |
| ------------ | ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `baseUrl`    | string | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | HTTPS OpenAI-compatible endpoint for the API key's region, workspace, or Coding Plan. |
| `clientName` | string | Package application name                                 | Client name used in the provider request user agent.                                  |

Alibaba Cloud Model Studio API keys are region-specific. Set `baseUrl` to the OpenAI-compatible API Host shown when the key is created. Coding Plan keys use `https://coding-intl.dashscope.aliyuncs.com/v1`. `/connect` stores the key without making a billable model request; the first turn validates that the key, endpoint, and selected model are compatible.

### `openai-chatgpt`

| Option          | Type             | Default  | Description                                                 |
| --------------- | ---------------- | -------- | ----------------------------------------------------------- |
| `contextWindow` | Positive integer | `260000` | Upper bound applied to the model's reported context window. |

Other built-in plugins currently have no configuration options. A custom plugin receives the object under `pluginConfig` whose key matches its exported plugin name.

## Complete example

Every option is optional. A configuration using all currently supported built-in options looks like this:

```json
{
  "plugins": ["/absolute/path/to/example-plugin"],
  "provider": "openai-chatgpt",
  "model": "gpt-5.6-terra",
  "ui": "tui",
  "permissions": {
    "allow": ["bash(git status*)"],
    "ask": ["bash(git push*)"],
    "deny": ["bash(rm -rf /*)"]
  },
  "modes": {
    "paranoid": { "ask": ["*"] }
  },
  "redaction": {
    "environment": ["MY_PROJECT_TOKEN"]
  },
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    }
  },
  "pluginConfig": {
    "tui": {
      "showOutputs": false,
      "showThinking": false
    },
    "project-instructions": {
      "maxBytes": 65536
    },
    "mcp": {
      "servers": {
        "local-tools": {
          "transport": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/server.js"]
        }
      }
    },
    "lsp": {
      "servers": {
        "typescript": {
          "command": "typescript-language-server",
          "args": ["--stdio"],
          "fileTypes": {
            ".ts": "typescript",
            ".tsx": "typescriptreact"
          },
          "rootMarkers": ["tsconfig.json", "package.json", ".git"]
        }
      }
    },
    "alibaba-cloud": {
      "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1"
    },
    "openai-chatgpt": {
      "contextWindow": 260000
    },
    "example-plugin": {
      "enabled": true
    }
  }
}
```
