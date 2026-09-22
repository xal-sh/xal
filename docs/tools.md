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
