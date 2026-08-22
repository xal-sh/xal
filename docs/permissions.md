# Permissions and security

Control which tools can run, define permission modes, and prevent sensitive values from reaching models or stored output.

## Permission rules

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

Chained commands are evaluated per segment, so `git status && rm /etc/hosts` asks even though `git status` alone would not. Commands using substitution or grouping that cannot be split safely always ask. Built-in risky-command rules are ordinary rules, so configuration can override them. For example, `"allow": ["bash(curl *)"]` stops `curl` from asking.

## Built-in modes

Xal ships three modes, cycled while the session is idle with the `session.next-mode` shortcut, Shift+Tab by default:

- `normal` is the default. Actions run without confirmation unless they are risky: shell commands whose file arguments, redirect targets, or `cd` destinations leave the workspace; destructive commands aimed at the workspace root or `.git`; file writes and edits outside the workspace; privileged or system-level commands such as `sudo` and `dd`; network fetches with `curl` or `wget`; force pushes; package publishes; and reads of `.env` files or key material. MCP calls run without confirmation unless an explicit permission rule asks or denies them. Deletes and other file operations inside the workspace run without prompting because workspace undo can restore them. Writes to the system temporary directory are also allowed.
- `plan` is read-only. Tools that mutate anything are refused before they run.
- `yolo` converts every ask into an allow. Deny rules still block actions.

## Interactive terminal tools

`exec_command` starts a command in a PTY on macOS and Linux. It returns completed output when the command exits within its yield period, or a session ID that `write_stdin` can use to send input, poll output, and resize the terminal. These tools are not exposed by native Windows builds because the native PTY backend is Unix-only.

`exec_command` applies the same command-risk rules as `bash`. An unsandboxed `workdir` outside the workspace asks before execution. `sandbox: "read"` prevents filesystem writes, while `sandbox: "workspace"` permits writes only inside the session workspace and system temporary directories, regardless of the selected `workdir`. Both sandbox modes block network access and run without approval.

Nonempty `write_stdin` input and terminal resize requests ask by default because input or resize events can cause the running process to perform arbitrary mutations. Empty input only polls output and is read-only when no terminal dimensions are supplied. Explicit permission rules can override the prompt, for example `"allow": ["write_stdin(*)"]`, while deny rules still take precedence.

Interactive processes can outlive an individual tool call, so starting one that can write, sending nonempty input, or resizing its terminal invalidates workspace undo history. Starting a read-sandboxed command and polling with empty input and no dimensions do not invalidate undo history. Completed sessions retain their final output for ten minutes or until it is polled, and all remaining sessions are terminated when their owning Xal session ends.

Set the default for new TUI and headless sessions in `config.json`:

```json
{
  "mode": "plan"
}
```

The default is `normal` when `mode` is omitted. Override it for one TUI session with `xal --mode plan`, `xal --mode normal`, or `xal --mode yolo`. For a headless run, place the option after the command, such as `xal run --mode yolo "prompt"`.

## Plan mode

`/plan [prompt]` enters plan mode and can submit the planning request in the same command. The agent grounds repository facts with read-only tools, asks structured questions only for material choices that cannot be discovered, and produces a self-contained implementation plan. `submit_plan` saves the complete Markdown as the session-local `plan.md`, renders it for review, and offers three outcomes. Free-form review input becomes revision feedback, and each resubmission replaces the complete proposal.

- **Approve and build** restores the writable permission mode that was active before planning and continues in the same conversation with the approved plan in context. If the prior mode was read-only, approval uses `normal`.
- **Clear context and build** approves the plan, ends the planning conversation, and starts a new session whose first prompt is the approved plan. Planning transcripts are usually long and the implementation does not need them; the option reports how much of the context window the planning conversation occupies so the tradeoff is visible before choosing.
- **Request changes** keeps plan mode active so the proposal can be revised.

A dismissed review leaves plan mode active and waits for new direction. User-driven mode changes are refused while a turn, approval, or input request is active so one turn cannot silently cross permission boundaries.

## Custom modes

Custom modes are defined under `modes` and appear in the TUI mode cycle and `--mode`:

```json
{
  "modes": {
    "paranoid": { "ask": ["*"], "guidance": "Every action needs confirmation." },
    "trusting": { "base": "normal", "allow": ["bash(curl *)", "write(/*)"] }
  }
}
```

`base` selects the built-in mode a custom mode behaves like. It defaults to `normal`; `plan` inherits read-only behavior and `yolo` inherits ask-skipping. `allow`, `ask`, and `deny` are mode-scoped rules that apply only while the mode is active. They sit above global `permissions` rules and below approvals remembered from the approval prompt. `guidance` replaces the mode instructions shown to the model.

Built-in mode names cannot be redefined. A session restored with a mode that no longer exists falls back to `normal`.

## Redaction

| Option        | Type       | Default | Description                                                     |
| ------------- | ---------- | ------- | --------------------------------------------------------------- |
| `values`      | `string[]` | `[]`    | Exact sensitive values to replace.                              |
| `environment` | `string[]` | `[]`    | Environment variable names whose current values should be used. |

```json
{
  "redaction": {
    "environment": ["MY_PROJECT_TOKEN"],
    "values": ["sensitive-literal"]
  }
}
```

Matches are case-sensitive and normally become `[REDACTED]` before content reaches a model, session or prompt-history storage, tool-output artifacts, CLI output, or the TUI. Xal chooses a safe alternate marker when a configured value is part of that text. Provider access tokens, refresh tokens, and API keys in the credential store are included automatically. Prefer `environment` for additional values so the secret itself does not need to appear in a configuration file.

Custom plugins can add values from their own credential sources with `ctx.registerSecrets`.
