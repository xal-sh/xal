# Built-in tools

Xal registers its built-in tools at startup, but the model is only offered the ones that apply to the current session. Availability is evaluated on every provider request from the session kind, whether the session is interactive, and the active permission mode. A tool that is registered but unavailable is not silently unknown: if the model calls one anyway, the call fails with a message naming the session state rather than reporting an unknown tool.

## Files

| Tool    | Purpose                                                                  | Availability        |
| ------- | ------------------------------------------------------------------------ | ------------------- |
| `read`  | Read a text file with line numbers, paginated by an output byte budget.  | Always              |
| `write` | Replace a file entirely, or create it along with missing parent folders. | Writable modes only |
| `edit`  | Replace an exact string in an existing file.                             | Writable modes only |

`write` and `edit` are withheld in read-only modes such as `plan`, because every call would be refused before it ran. `bash` stays available there, since whether a command mutates anything depends on its arguments.

### Reading before writing

`write` will not replace a file the session has not read. An existing file must have been read with `read` in the current session, and its contents must not have changed since that read; otherwise the call fails and asks for the file to be read again. Creating a new file has no precondition.

`edit` has no such requirement, because `old_string` must already match the file exactly, which proves the replaced span is unchanged. The exception is `replace_all`, which rewrites occurrences the model may never have seen, so it requires the same read-and-unchanged check as `write`.

The check compares a hash of the file contents, so reformatting that leaves the bytes identical is not treated as a change, and two edits within the same millisecond cannot be confused. The file state is scoped to a session and is cleared when the session resets or changes workspace. Note that reading any part of a file satisfies the requirement, including a one-line read.

## Search and inspection

| Tool       | Purpose                                              | Availability                |
| ---------- | ---------------------------------------------------- | --------------------------- |
| `grep`     | Search file contents with a regular expression.      | Always                      |
| `glob`     | Match file paths by glob pattern.                    | Always                      |
| `bash`     | Run a command in a persistent shell session.         | Always                      |
| `webfetch` | Fetch a URL and return its body as text or Markdown. | Always                      |
| `lsp`      | Query a language server for diagnostics and symbols. | When a server is configured |
| `skill`    | Load the full instructions for a catalogued skill.   | Always                      |
| `memory`   | Read or replace user-global memory.                  | Primary sessions            |

## Code Mode

The experimental `code_mode` tool lets the model run a stateless JavaScript program that combines read-only tools and emits only selected results into context. It is disabled by default; enable it with [Code Mode configuration](/docs/configs#code-mode). Ordinary tools remain available, and a simple read or search does not need a program. Code Mode works across providers, including headless runs, task agents, and read-only permission modes.

The `code` argument is an asynchronous JavaScript function body. `await callTool(name, args)` returns a text string from `read`, `glob`, `grep`, or `webfetch`, using that tool's ordinary arguments. `emit(value)` appends text or a JSON-serializable value to the final result. Return values are not automatically emitted. For example:

```js
const releases = await Promise.all([
  callTool("webfetch", { url: "https://api.github.com/repos/openai/codex/releases" }),
  callTool("webfetch", { url: "https://api.github.com/repos/anomalyco/opencode/releases" }),
])
emit(
  releases.map((text) =>
    JSON.parse(text)
      .filter((release) => !release.prerelease && !release.draft)
      .slice(0, 3)
      .map((release) => ({ version: release.tag_name, date: release.published_at, notes: release.body })),
  ),
)
```

Only emitted values and the trace location become the outer tool result. Child results are not appended as separate model-facing tool messages. Results reach JavaScript after hooks and secret redaction, but before the harness's 2,000-line/50-KiB preview limit. Tool-specific limits still apply: `read` still returns numbered, possibly shortened lines rather than raw file bytes, and searches still cap their match counts. A hook that changes JSON output to other text can make `JSON.parse` fail.

### Isolation and limits

Programs run in a fresh QuickJS WebAssembly context with no host filesystem, network, process, credential, import, or timer APIs. Files and URLs are accessible only through approved child calls. Shell commands, MCP tools, writes, interactive tools, session-changing tools, and nested Code Mode are not supported. Only currently available, shared, read-only tools without undo actions may be called.

| Resource                  | Limit per program                       |
| ------------------------- | --------------------------------------- |
| Source and emitted output | 32 KiB each                             |
| JavaScript heap           | 64 MiB                                  |
| JavaScript execution time | 1 second, excluding time awaiting tools |
| Total elapsed time        | 60 seconds, including approvals         |
| Child calls               | 32, with at most 4 in flight            |
| Child result text         | 5 MiB per result, 16 MiB total          |
| Child arguments           | 32 KiB per call                         |

`Promise.all` queues excess calls behind the concurrency limit. Await every child call; unfinished calls are cancelled when the program exits. Programs cannot suppress tool failures, denials, or host call/output/CPU limit errors with `try/catch`: the outer call still fails and does not return partial emitted output. QuickJS allocation errors follow ordinary JavaScript exception semantics and can be caught; the heap ceiling remains enforced. Unresolved promises without pending tools fail instead of waiting forever. Known-secret redaction is a safeguard, not a guarantee that arbitrary sensitive data is detected.

Each child call goes through the existing before-tool hooks, permission rules and approvals, execution, and after-tool hooks. Approval requests are serialized. Cancellation propagates to pending approvals and active tools. The program stops waiting even when a trusted hook or underlying read does not honor cancellation; late results cannot re-enter its disposed JavaScript context. Repeat-loop detection is shared with ordinary calls in the turn, including denied child calls and stopping the turn after a repeated-loop warning. Parent programs are compared using their logical results, without the per-run trace location. Allowing `code_mode` does not authorize its child calls. For example, `permissions.deny: ["webfetch(*)"]` still blocks a program from fetching URLs.

### Traces

Child activity appears under the parent tool. A private `calls-<id>` directory under the session output directory contains numbered JSON trace files, created before execution and updated with the effective call arguments and complete redacted result or failure. Each record includes a version and parent call ID; files use mode `0600`. The outer result includes `Tool trace: <directory>`, including on failure, so the model or user can inspect details with ordinary tools when needed. Trace-write failures fail the program rather than silently dropping its audit record.

These files are local artifacts, not conversation items or replay instructions. Resuming a completed program does not re-execute its child calls, and no JavaScript state survives between programs. As with other pending tools, an interrupted outer call without a recorded result may be retried when a session is resumed; the initial tool allowlist therefore excludes mutating operations.

## Planning and interaction

| Tool                 | Purpose                                   | Availability                |
| -------------------- | ----------------------------------------- | --------------------------- |
| `update_plan`        | Track ordered steps and their progress.   | Outside plan mode           |
| `submit_plan`        | Submit a plan for review and approval.    | Interactive plan mode       |
| `request_user_input` | Ask the user a structured question.       | Interactive sessions        |
| `ask_parent`         | Ask the owning agent a blocking question. | Task agents                 |
| `classify`           | Evaluate content with typed questions.    | When TypeSafe AI is enabled |

## Background work

| Tool                                   | Purpose                                        | Availability                          |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `task`                                 | Dispatch assignments to background agents.     | Primary interactive sessions          |
| `scheduler`                            | Wait for a duration, ending early on activity. | Always                                |
| `job_output`, `job_status`, `job_kill` | Collect, inspect, and stop background jobs.    | After the session starts a job        |
| `job_send`, `job_extend`, `wait_agent` | Steer and wait on task agents.                 | After the session starts a task agent |

See [background work](background-work.md) for how these gates behave over a session.

## Worktrees

| Tool              | Purpose                                                       | Availability            |
| ----------------- | ------------------------------------------------------------- | ----------------------- |
| `worktree_enter`  | Create a managed worktree and move the session into it.       | Primary, writable modes |
| `worktree_exit`   | Leave the managed worktree, keeping or removing the checkout. | Primary, writable modes |
| `worktree_remove` | Remove a managed worktree other than the current workspace.   | Primary, writable modes |

Entering a worktree changes the session workspace, which clears per-session tool state including recorded file reads.

## MCP

Tools from configured MCP servers are hidden until `mcp_tool_search` loads them for the session, so an attached server costs nothing until it is used. `mcp_resources`, `mcp_read_resource`, `mcp_prompts`, and `mcp_get_prompt` appear only when a connected server offers resources or prompts. See [integrations](integrations.md).
