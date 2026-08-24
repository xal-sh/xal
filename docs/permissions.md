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

`allow`, `ask`, and `deny` are arrays of permission rules. A rule is either a tool name, such as `bash`, or a tool and subject pattern, such as `bash(git status*)` or `write(src/*)`. `*` matches any sequence of characters and also works in the tool name, so `mcp__github__*` matches every tool from that MCP server and `*` alone matches every tool.

Permission resolution is deterministic:

1. Global, active-mode, plugin, and inherited deny rules block first.
2. A read-only mode blocks mutations even when an allow rule matches.
3. Explicit global, active-mode, or plugin ask rules prompt in normal and plan mode. An ask wins over allow rules and remembered approvals.
4. Configured allows and project or session approvals allow the action.
5. Built-in sensitive decisions are reviewed in normal mode, prompt in plan mode when read-only, and run in yolo mode.
6. Routine built-in decisions, read-only actions, and OS-sandboxed commands run automatically.
7. Other normal-mode actions are reviewed by the safety classifier. Other read-only plan actions and all yolo actions run.

Yolo deliberately skips asks and classification, but deny rules still block. A custom mode retains the behavior of its built-in base.

Chained commands are evaluated per segment. Explicit rules that match a normalized segment still apply to the whole call. Commands using substitution or grouping that cannot be split safely are classified rather than treated as routine. A narrow allow rule, such as `"allow": ["bash(curl *)"]`, bypasses classification for the matching action. Use ask or deny for durable checkpoints that must not depend on model judgment.

## Built-in modes

Xal ships three modes, cycled while the session is idle with the `session.next-mode` shortcut, Shift+Tab by default:

- `normal` is the default. Ordinary read-only calls, OS-sandboxed commands, workspace or temporary-directory file edits, and configured allows run immediately. Sensitive reads and other unresolved actions are independently classified before execution. A blocked or unavailable classification fails closed and the action does not start.
- `plan` is read-only. Tools that mutate anything are refused before they run. Explicit asks still prompt for read-only actions.
- `yolo` runs asks and classifier candidates without prompting. Deny rules still block actions.

### Normal-mode safety review

Normal mode sends a separate, tool-free request through the session's active provider, profile, and model. There is no classifier-specific model setting. The request uses the lowest thinking effort supported by that model, adds provider latency and token cost, and appears in the local usage ledger with phase `permission_classification`.

The classifier compares the pending action with direct user intent, project guidance, and trusted workspace boundaries. It conservatively blocks actions that are materially broader than the request or involve destructive operations, privilege or permission escalation, secrets, external data transfer, publishing, deployment, credentials, production or shared infrastructure, or prompt-injection-driven behavior.

Classifier context includes:

- Composed system and project guidance
- Direct user messages
- Prior tool names and arguments
- The active workspace and repository root
- Remote destinations captured when that workspace became active
- A current dirty-worktree signal
- The pending action and its read-only or sandbox status

Classifier context excludes assistant prose, reasoning, tool results, direct-shell output, and generated compaction summaries. Existing redaction applies before the request. Remotes added after workspace activation are not silently trusted. After context compaction, earlier user boundaries may no longer be available because generated summaries are excluded. Put durable restrictions in `permissions.ask` or `permissions.deny`.

A blocked, malformed, unavailable, interrupted, or stale verdict becomes a denied tool result with a safety reason so the agent can choose a safer alternative. The tool is never prepared or started. After three consecutive classifier blocks, the next classifier candidate falls back to the existing approval prompt in an interactive primary session. Headless sessions and task agents continue to fail closed because they cannot collect that approval. The counter resets after an allowed classification, approved fallback, mode or workspace change, history movement, or compaction.

Write-capable task batches are classified before dispatch. Read agents remain in plan mode. Write agents inherit the parent's normal, custom, or yolo behavior, and every child action passes through the same permission service. Parent and custom-mode denies remain effective in children. An isolated child uses its own worktree root while retaining only the parent's captured remote trust facts.

Classifier denials are stored and exported as ordinary redacted tool outcomes with denial cause `classifier`. The TUI shows `Reviewing action` while the provider request is pending and labels blocked tools as safety blocks. Usage and profiler records contain provider, model, phase, outcome, token counts, and latency, but never classifier prompts, arguments, verdict reasons, paths, profile IDs, or credentials.

## Interactive terminal tools

`exec_command` starts a command in a PTY on macOS and Linux. It returns completed output when the command exits within its yield period, or a session ID that `write_stdin` can use to send input, poll output, and resize the terminal. These tools are not exposed by native Windows builds because the native PTY backend is Unix-only.

`exec_command` follows the same normal-mode review as `bash`. An unsandboxed command or a `workdir` outside the workspace is classified unless an explicit rule resolves it first. `sandbox: "read"` prevents filesystem writes, while `sandbox: "workspace"` permits writes only inside the session workspace and system temporary directories, regardless of the selected `workdir`. Both sandbox modes block network access and run without classification.

Nonempty `write_stdin` input and terminal resize requests are classified in normal mode because the running process can mutate state. Input spanning multiple calls is accumulated until command submission so splitting a command does not bypass explicit deny or ask rules. Empty input only polls output and is read-only when no terminal dimensions are supplied.

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
- **Clear context and build** approves the plan, ends the planning conversation, and starts a new session whose first prompt is the approved plan.
- **Request changes** keeps plan mode active so the proposal can be revised.

A dismissed review leaves plan mode active and waits for new direction. User-driven mode changes are refused while a turn, approval, input request, or classification is active so one turn cannot silently cross permission boundaries.

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

`base` selects the built-in mode a custom mode behaves like. It defaults to `normal`. A normal-based mode classifies unresolved actions, a plan-based mode stays read-only, and a yolo-based mode skips asks and classification. `allow`, `ask`, and `deny` are mode-scoped rules that apply only while the mode is active. Ask rules win over every allow or remembered approval in normal and plan modes. `guidance` replaces the mode instructions shown to the model and is included as trusted classifier guidance.

Existing permission rules and custom modes are the only classifier tuning surface. There is no classifier-specific provider, model, policy tier, environment schema, or recently-denied management screen.

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
