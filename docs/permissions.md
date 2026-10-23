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

Chained shell commands are also checked per segment for deny rules. Shell commands require approval by default, including commands using substitution, grouping, scripts, or a sandbox, because their filesystem access cannot be confined to the working directory. Explicit allow rules and remembered approvals can whitelist them; for example, `"allow": ["bash(git status)"]` authorizes that command. Use narrow patterns: `bash(git status*)` also matches commands appended after `git status`.

### Outside-directory access and whitelisting

In `normal` and `plan`, agent tool calls that access files outside the session's current working directory require approval, including reads. This covers absolute paths, `..`, home-directory paths, symlink targets, and temporary directories. File and search tools resolve symlinks, including existing parents of files that have not been created yet, before checking the boundary. File permission subjects use the resolved path, relative inside the working directory and absolute outside it. Ask and deny rules also check the original path so aliases cannot bypass them. `glob` and `grep` use the resolved search root as their subject, not the search pattern.

The approval prompt offers **Allow once**, **Allow this session**, **Always allow**, and **Deny**. The session and always choices display the rule being whitelisted. Session approvals are scoped to that session and working directory; always approvals are saved per working directory in `permissions.json` under the Xal home directory. Explicit `permissions.allow` rules and custom-mode allow rules can also whitelist access. Plugin-provided default allow rules do not bypass the outside-directory check. Deny rules still win, and no approval permits a write in plan mode.

For example, `read(/shared/reference/*)` permits reads under that directory but not writes, while `grep(/shared/reference)` permits searches rooted there. Search approvals are scoped to the displayed root. Approving a shell command authorizes its filesystem access wherever the command reaches; it does not create a directory sandbox. The macOS read sandbox prevents writes, and the workspace sandbox limits writes to the workspace and temporary directories, but both allow outside reads and therefore still require approval.

Language servers and MCP calls can access files indirectly, so they also require approval unless explicitly whitelisted, even when their input looks local. Global-memory tool calls, loading skills outside the workspace, and worktree operations follow the same approval policy. In noninteractive runs and task agents, calls requiring approval are refused instead of silently allowed. These checks govern agent tool calls, not Xal's own configuration, credentials, session storage, enabled startup context sources, or trusted in-process plugins and hooks.

## Built-in modes

Xal ships three modes, cycled while the session is idle with the `session.next-mode` shortcut, Shift+Tab by default:

- `normal` is the default. Dedicated file and search operations inside the working directory run without confirmation unless marked sensitive, such as reads of `.env` files or key material. Outside-directory access, including reads and temporary files, requires approval unless explicitly whitelisted. Shell commands, language-server queries, MCP calls, and worktree operations also require approval because their effects are not confined to that directory.
- `plan` is read-only and uses the same outside-directory approval boundary, including for reads. File-modifying tools (`write`, `edit`, and the `worktree_*` tools) are withheld from the model entirely, and any other tool call that would mutate something is refused before it runs. Approval or whitelisting does not relax this read-only restriction.
- `yolo` converts every ask into an allow. Deny rules still block actions.

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

A dismissed review leaves plan mode active and waits for new direction. User-driven mode changes are refused while a turn, approval, or input request is active so one turn cannot silently cross permission boundaries. After a successful change to a writable mode, the model is explicitly told that plan mode is no longer active so earlier planning context cannot keep blocking writes.

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

`base` selects the built-in mode a custom mode behaves like. It defaults to `normal`; `plan` inherits read-only behavior and `yolo` inherits ask-skipping. `allow`, `ask`, and `deny` are mode-scoped rules that apply only while the mode is active. They sit above global `permissions` rules and below approvals remembered from the approval prompt. `guidance` replaces the mode-specific workflow instructions shown to the primary agent; Xal still identifies the primary agent's current mode and whether it is read-only.

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
