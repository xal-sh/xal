# Built-in tools

Xal registers its built-in tools at startup, but the model is only offered the ones that apply to the current session. Availability is evaluated on every provider request from the session kind, whether the session is interactive, and the active permission mode. A tool that is registered but unavailable is not silently unknown: if the model calls one anyway, the call fails with a message naming the session state rather than reporting an unknown tool.

Every call is checked against the tool's declared parameters before permission rules, approvals, or execution. A wrong type, a missing required argument, an unknown argument where the schema forbids extras, or a value outside an `enum` fails the call with a message naming each problem, so the model can correct it instead of having the argument silently ignored. A `null` value for an optional argument counts as omitted. Schema constructs Xal does not check, such as `$ref`, `allOf`, `not`, and conditionals, are left to the tool itself, and `anyOf` or `oneOf` pass when any branch matches. This applies to MCP tools as well, using the input schema their server declares. Structured output's `submit_output` is the exception: it keeps its own schema check, which counts rejected attempts.

## Files

| Tool    | Purpose                                                                  | Availability        |
| ------- | ------------------------------------------------------------------------ | ------------------- |
| `read`  | Read a text file with line numbers, or list a directory's entries.       | Always              |
| `write` | Replace a file entirely, or create it along with missing parent folders. | Writable modes only |
| `edit`  | Replace exact text in an existing file, once or several times per call.  | Writable modes only |

`write` and `edit` are withheld in read-only modes such as `plan`, because every call would be refused before it ran. `bash` stays available there, since whether a command mutates anything depends on its arguments.

### Reading files and directories

Given a directory, `read` lists its entries sorted by name, marking subdirectories with a trailing `/`, and pages them with the same `offset` and `limit` as file lines. Listing a directory does not count as reading any file in it.

Given a `.png`, `.jpg`, or `.jpeg` file whose contents really are PNG or JPEG, `read` returns the image itself along with a line naming its type, dimensions, and size, so the model can look at screenshots, diagrams, and other visual assets. Images over 3.75 MB, or wider or taller than 8,000 pixels, fail with a request to resize them, because providers reject them and an image already in the conversation would be sent with every later request. Since not every provider accepts images inside tool results, Xal sends the images from consecutive tool results as one user message right after those results. Only the four most recent tool-result images are resent with each request, so screenshots piling up in a long session cannot push requests past provider size or image-count limits; an older one is replaced by a note to read the file again. When the selected model does not accept image input, the tool result says the image was omitted instead. If an after-tool hook fails, the failure is returned without the image. Images reach the model only from direct `read` calls: a Code Mode child call returns just the text line with a note, and read-ahead skips images. A file with an image extension but other contents is read as an ordinary file.

When `read` or `edit` is given a path that does not exist, the failure names up to 5 files in the same directory whose names share the requested stem ignoring case, such as `config.ts` and `Config.test.tsx` for a missing `config.js`, or says that the directory is missing too.

### Reading before writing

`write` will not replace a file the session has not read. An existing file must have been read completely with direct `read` calls in the current session, and its contents must not have changed since those reads. Coverage can accumulate across overlapping or out-of-order pages of the same file version, including through symlink aliases, but every line must be covered without shortened lines. Otherwise the call fails and asks for the missing content to be read, or for a targeted `edit` instead. Empty files count as completely read. Creating a new file has no precondition, and the content supplied to a successful `write` remains known for subsequent writes.

`edit` has no such requirement, because `old_string` must already match the file exactly, which proves the replaced span is unchanged. The exception is `replace_all`, which rewrites occurrences the model may never have seen, so it requires the same read-and-unchanged check as `write`.

A targeted edit is not a substitute for reading the file. It carries complete read authorization forward only when the entire pre-edit file matches the version the session already knew completely. Partial coverage is discarded after an edit because line positions may have changed. If the file was unread or another actor changed it, the targeted edit can still succeed, but a later `write` or `replace_all` requires a fresh `read`. This prevents an edit to one unchanged span from authorizing an overwrite of unseen changes elsewhere in the file. Consecutive edits to a known, unchanged version do not require redundant reads.

The check compares a hash of the file contents, so reformatting that leaves the bytes identical is not treated as a change, and two edits within the same millisecond cannot be confused. The file state is scoped to a session and is cleared when the session resets or changes workspace, and whenever the conversation context is replaced by compaction, rewind, or redo, since earlier reads may no longer be in the model's context. Stale-read pruning is the exception: it removes a read only when a later, untruncated read of the same canonical path and content hash actually displayed all of its lines. Requested defaults do not imply a full read, and writes do not supersede historical evidence. Results without coverage metadata, including older session records, are retained. Redaction, hooks, or output shortening invalidate coverage when they change the displayed text. Write authorization is recorded only after those transformations and the round's output budget have been applied. A one-line read of a larger file, a shortened line, or a saved full-output artifact does not authorize overwriting unseen content. Read smaller pages directly, or use targeted edits when a line cannot be shown in full. Code Mode child reads and speculative read-ahead do not grant write authorization: their contents are not guaranteed to reach the model unchanged. Old session coverage without total-line metadata remains readable but does not grant new authorization.

When `old_string` does not occur in the file, the failure points at the closest text instead of leaving the model to guess. Xal compares the lines of `old_string` with every same-sized window of the file, ignoring whitespace. If at least half of the non-blank lines match, the error names that line range and prints up to 30 of its lines in `read` format, so the model can copy the exact text. The closest text is only a hint and is never applied.

When `old_string` occurs more than once and `replace_all` is not set, the failure lists the lines where the matches start, up to 10 lines, so the model can widen `old_string` around the intended one without reading the file again.

### Several replacements in one call

`edit` takes either `old_string` and `new_string` for one replacement, or `edits`, a list of `old_string`, `new_string`, and optional `replace_all` entries, for several replacements in the same file. Passing both forms fails the call. Every `old_string` is matched against the file as it was before the call, not against the result of earlier entries, so the line numbers in failure hints refer to the file the model read. Entries whose matched text overlaps fail the call with the indexes of both entries. With two or more entries, a failure that comes from one entry, such as text that is not found or matches more than once, names it as `edits[n]`, counting from 0. The file is written only when every entry applies, so a failed call leaves it unchanged, and the result shows a single diff of all the replacements. Any entry with `replace_all` brings in the same read-and-unchanged check as a single `replace_all` edit.

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

`grep` returns at most 250 results and `glob` at most 100. Both accept `offset` to skip leading results, and the footer of a truncated result names the offset that continues it. When `path` does not exist, both fail with `Path not found` and the same similar-name suggestions as `read`. `grep` treats `pattern` as a Rust regular expression unless `literal` is true, which matches the text literally so characters such as `(`, `.`, and `[` need no escaping. Matches stay within one line unless `multiline` is true; without it, a pattern that contains a newline, such as `foo\nbar`, fails instead of silently matching nothing. With `multiline`, a match may span lines, every line it covers is shown with its own line number, and the header counts matches rather than matching lines, with overlapping or adjacent matches merged into one. `.` still stops at a newline unless the pattern sets the `(?s)` flag. The `glob` pattern of `glob`, and the `glob` filter of `grep`, match a file when they match its path relative to `path` (or to the folder containing it, when `path` is a file) or relative to the working directory, so `tools/*.ts` with `path: "src"` finds `src/tools/registry.ts`. An absolute pattern matches absolute paths instead. When a `grep` glob excludes every file, the result says that nothing was searched rather than reporting no matches. In content mode, `grep` also accepts `context` to show up to 10 lines before and after each match. Context lines are written `path-line-text` instead of `path:line:text`, `--` separates groups that are not adjacent, and only matches count toward the limit and the offset.

`bash` runs commands with Bash so that common idioms such as unmatched globs and word splitting behave as models expect. It uses `$SHELL` when that names Bash, otherwise the first `bash` on `PATH`. When Bash is not installed, and on Windows, it uses `$SHELL`, falling back to `/bin/sh` when `$SHELL` is unset or not a supported shell. Interactive startup files are not loaded, and the system prompt names the shell in use.

Exact foreground `bash` commands matching [configured verification checks](/docs/configs#verification-checks) record execution receipts. These commands use a fresh shell at the session workspace rather than inherited shell state, run exclusively, and cannot be launched or promoted into the background. Other shell behavior is unchanged.

Foreground commands default to a 120-second timeout, configurable up to 600 seconds. A timed-out persistent shell receives TERM and then KILL after a 1.5-second grace period if cleanup is still pending. On Unix, the exited shell remains unreaped until process-group cleanup finishes, preventing late signals from targeting a reused group ID. Its state is discarded: the next command starts a fresh shell at the session workspace. Isolated commands use immediate termination. This is process-group cleanup, not a guarantee against descendants that deliberately escape that group.

## Output limits and recovery

Tool results normally have a 2,000-line/50-KiB preview limit; larger results are saved privately with a recovery path. Foreground Bash captures output incrementally instead of accumulating the entire command output in memory. It starts a private log once output exceeds its preview threshold, returns a bounded head/tail preview within 20 KiB, and labels the artifact partial if native queues lost data or the log was capped. Log-write failures are reported rather than described as a full capture. Streaming redaction happens before persistence.

Each assistant tool-call round also has a 200-KiB soft result budget shared across its execution batches. When a fresh batch exceeds the remaining budget, the largest fresh results are saved and reduced to 2-KiB previews first. Already-saved results keep their original recovery path and completeness notice when their previews shrink again. This uses execution metadata, not recovery-looking text printed by a command; changes by hooks or redaction invalidate that metadata. A failed save retains a bounded in-memory preview and an explicit warning rather than discarding all output. Earlier results are frozen and persisted as returned, so later batches and resumed requests do not change their previews. Retrying an interrupted round subtracts its already-persisted results from the allowance; the next assistant round starts a new budget. The per-result floor means many small results can exceed this soft budget. Saved artifacts are local files, not a promise that the underlying process produced no uncaptured output; follow any incompleteness notice. Retrieve historical output instead of rerunning state-changing commands to recreate it.

## Repeated tool calls

When the same tool arguments return identical results twice in a turn, Xal blocks the next identical call with a warning. Retrying again without progress stops the turn. Tracked workspace changes clear earlier non-denial results and warnings, so a check or read can run again after an edit even if its output will be identical. This reuses Git undo tracking rather than scanning the workspace again: file edits, foreground shell changes (including changes made before a command fails), and workspace switches can invalidate earlier results. Only observed working-tree, Git HEAD, or index changes count as progress; invalidating undo without observing a change does not. A no-op write or an unchanged failed edit does not clear the guard. External edits, non-Git workspaces, and plugin operations without snapshot tracking are not detected by this mechanism.

Permission and hook denials retain their history and warnings across workspace changes: editing an unrelated file does not authorize retrying a refused action. The same rules apply to Code Mode child calls and their parent programs. Tools explicitly designed for repeated waiting keep their existing exemption; new user input and delivered background activity still reset the loop guard.

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

Each child call goes through the existing before-tool hooks, argument validation, permission rules and approvals, execution, and after-tool hooks. Approval requests are serialized. Cancellation propagates to pending approvals and active tools. The program stops waiting even when a trusted hook or underlying read does not honor cancellation; late results cannot re-enter its disposed JavaScript context. Repeat-loop detection is shared with ordinary calls in the turn, including denied child calls and stopping the turn after a repeated-loop warning. Parent programs are compared using their logical results, without the per-run trace location. Allowing `code_mode` does not authorize its child calls. For example, `permissions.deny: ["webfetch(*)"]` still blocks a program from fetching URLs.

### Traces

Child activity appears under the parent tool. A private `calls-<id>` directory under the session output directory contains numbered JSON trace files, created before execution and updated with the effective call arguments and complete redacted result or failure. Each record includes a version and parent call ID; files use mode `0600`. The outer result includes `Tool trace: <directory>`, including on failure, so the model or user can inspect details with ordinary tools when needed. Trace-write failures fail the program rather than silently dropping its audit record.

These files are local artifacts, not conversation items or replay instructions. Resuming a completed program does not re-execute its child calls, and no JavaScript state survives between programs. As with other pending tools, an interrupted outer call without a recorded result may be retried when a session is resumed; the initial tool allowlist therefore excludes mutating operations.

## Planning and interaction

| Tool                 | Purpose                                   | Availability                |
| -------------------- | ----------------------------------------- | --------------------------- |
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
