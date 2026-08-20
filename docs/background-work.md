# Background work

Background work comes in two vocabularies. A _background session_ is a whole session that keeps working after you leave the terminal: `/bg` hands the running conversation to a detached worker process and returns you to the shell. _Background jobs_ are work inside a live session: task agents dispatched with the `task` tool and processes started with `bash` `background:true`. Jobs are tracked per session, deliver their results back into the conversation automatically, and share one set of TUI surfaces.

## Background sessions

`/bg` (alias `/background`) sends the current session to the background while it is working: the running turn pauses at a safe boundary (the in-flight model response and tool batch finish first), a detached worker process takes the session over, and the TUI exits to the shell with `session <id> continues in background; xal bg attach <id>`. `/bg` needs work in progress and refuses while a permission request or question is waiting for an answer. Anything still queued in the composer when the handoff happens is printed as `not sent: <text>` so nothing disappears silently.

In-flight background jobs cannot move between processes: they are stopped at detach and the stop is recorded in the transcript, so the model knows on resume. This also works when the main turn is idle and only task agents or background processes remain. The worker continues from the handoff notice, survives the terminal closing, and keeps state in `~/.xal/bg/<session-id>/`: `lease.json` with exclusive worker ownership, `state.json` with current status and activity, `control.json` for authenticated handoff and stop requests, and `worker.log` with the event stream. Workers are never respawned automatically; a session goes to the background only when you send it there.

Manage background sessions from the shell:

| Command                  | Purpose                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `xal bg` / `xal bg list` | List background sessions with status, title, and activity.                        |
| `xal bg attach <id>`     | Take a background session back into the TUI.                                      |
| `xal bg stop <id>`       | Ask a worker to stop gracefully and report if it does not acknowledge within 15s. |
| `xal bg clear [id]`      | Remove finished entries (or one entry) from the list.                             |

Ids accept unique prefixes. Statuses:

| Status        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `running`     | The worker is executing turns; the activity column shows what it is doing.       |
| `done`        | The work finished; the worker exited.                                            |
| `needs input` | The agent hit a permission request or question and stopped; attach to answer it. |
| `stopped`     | Stopped with `xal bg stop` (a pending request is denied as part of the stop).    |
| `failed`      | The turn or the worker failed; the detail column has the reason.                 |
| `died`        | The worker vanished without writing a final status; the row shows the log path.  |

Attach is a takeover handoff: a running worker pauses at the next safe boundary and exits, then the TUI resumes the session in place and continues the work. A pending permission request or interactive tool is re-raised interactively on attach. Interactive tools are deferred before execution, so work before a question is never replayed. Nothing is auto-denied while a session runs in the background, which also means the permission mode governs unattended progress: a session in a mode that asks for approval stops at the first request with `needs input`. Inside the TUI, `/bg list` opens the same manager as a picker: attach here, stop, show the log path, or remove an entry.

A background session stays an ordinary session. Once the worker cleanly releases its lease, `xal resume <id>` works as usual. While a lease is active, resuming is refused so two processes never write one transcript. If a worker dies without releasing its lease, attach the `died` entry to recover it safely.

## Task agents

Task agents are available for explicit delegation, not as the primary model's default workflow. The primary model is instructed to dispatch them only when the user or applicable `AGENTS.md` or skill instructions ask for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis alone do not authorize delegation.

The task tool's model-facing schema describes its mechanics and constraints but does not add a second global workflow prompt. Delegation policy is a separate primary-session prompt section so capability does not imply authorization.

The `task` tool dispatches a batch of up to 8 independent assignments. Each assignment becomes its own agent session that starts without conversation history: the batch's shared `context` plus the assignment text is everything it knows. The call returns agent ids immediately; up to `agents.maxConcurrent` agents run at once and the rest queue.

Each task declares its `access`:

- `read`: the agent runs in a read-only mode and cannot modify files.
- `write`: the agent inherits the parent's permission mode. With `isolation: "worktree"` it works in its own Git worktree and branch; otherwise it edits the shared checkout.

Dispatching any `write` task asks for approval. Sub-agents cannot ask for approval themselves; any action that would need it is denied automatically. Each agent runs until it produces a final report, reaches the `agents.timeoutMinutes` deadline, or exceeds its turn budget: after `agents.maxTurns` completed turns the agent is told to wrap up, and at 1.5× the budget its last report is returned as-is instead of running forever. The primary agent can inspect both budgets while the task runs and extend its deadline, soft turn budget, or both before either limit is reached.

A finished agent's report is delivered into the parent conversation automatically as a system notice, with no polling needed. Alongside the in-conversation result, every agent writes two durable files into the session directory:

- a Markdown task record (`agent-<id>-….md`) with the assignment, workspace, final report, and buffered transcript
- a full transcript log (`agent-<id>-….log`) written incrementally while the agent runs, so nothing is lost even if the process dies; logs cap at 64 MB and are marked `(capped)` past that

## Background processes

`bash` with `background:true` starts the command as a managed job and returns its id immediately. Output is captured into a bounded in-memory buffer (oldest middle dropped past ~400 KB, marked with `... N characters omitted ...`) and written completely to a `.log` file in the session directory. When the process exits, its result is delivered into the conversation automatically.

A running foreground `bash` command can be promoted to a background job at any moment with the `jobs.background` shortcut (default `ctrl+b`). The command keeps running, its output keeps flowing into the job, and the result is delivered when it exits. Killing a promoted command that ran in the persistent shell tears the shell session down; the next command starts a fresh one.

## Job tools

The model manages jobs with five tools:

| Tool         | Purpose                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `job_output` | Read process output or collect an agent report; agent waits return at a supervision checkpoint before the deadline. |
| `job_status` | Inspect queue state, activity, provider requests, tools, turn cycles, context, timing, and remaining deadline.      |
| `job_send`   | Queue guidance into a running task agent's current turn.                                                            |
| `job_extend` | Add up to 60 runtime minutes, 100 soft-budget turns, or both to a queued or running task agent per call.            |
| `job_kill`   | Stop a job. A process that ignores the graceful stop is hard-killed after 2 seconds.                                |

An explicit `job_output` wait cannot consume a task agent's whole runtime budget. It reserves a supervision window of up to one minute and returns with live status so the parent can inspect, extend, steer, or stop the task; a wait started while queued may return earlier because its runtime deadline has not started. If an agent still times out, collection includes a bounded transcript tail labeled as incomplete alongside the durable task-record path.

Stopping a job from the TUI is never silent: the result is marked `stopped by the user` and still delivered so the model knows what happened. A task agent remains unsettled until its runner has finished cleanup and saved its task record.

## TUI surfaces

- The status bar shows live counts (`2 agents · 1 job · …`) whenever background work exists.
- Running agents are summarized above the composer by ID and elapsed time; queued agents show `queued <time>` until they start.
- The navigator at the bottom lists every job: running rows first, then finished rows (newest first). The full viewer shows live activity, timing, context, tool, and turn metrics. Successfully completed agents are dismissed when the primary session returns to idle; failed agents and finished process jobs remain reviewable until dismissed or evicted, and jobs started by a sub-agent are attributed with `⟨agent-id⟩`.
- Normal transcript mode shows a completed background result as its ID and first report line. Use `display.toggle-details` (default `ctrl+o`) to reveal its assignment, status, line count, report output, and record path.

Open the navigator with `/agents` (alias `/jobs`), the `agents.open` shortcut (default `ctrl+x ctrl+a`), or by pressing `↓` with an empty composer.

Navigator keys:

| Key       | Action                                                     |
| --------- | ---------------------------------------------------------- |
| `↑` `↓`   | Move between rows; `↑` from `main` returns to the composer |
| `enter`   | Open the viewer for the selected agent or process          |
| `tab`     | Toggle an inline preview of the last output lines          |
| `x` / `k` | Stop a running job, or dismiss a finished row              |
| `esc`     | Close the viewer, collapse the preview, or leave           |

The viewer takes over the screen and follows the job's output live. While it is open, `↑`/`↓` keep moving the selection in the list below and `enter` switches the viewer to the selected job (or closes it on the viewed row), so you can hop between running agents without leaving the viewer. `pgup`/`pgdn` scroll the transcript, `home` jumps to the top, and `end` returns to the bottom and resumes following (scrolling up pauses following and shows `· paused`). For a running agent, `i` opens a steering input, type guidance and press `enter` to queue it into the agent's current turn; the transcript marks it as `User guidance`.

`agents.stop-all` (default `ctrl+x ctrl+k`) stops every running agent at once.

## Configuration

Every field in the top-level `agents` object must be an integer and is validated strictly.

| Option                  | Default | Range   | Description                                                 |
| ----------------------- | ------- | ------- | ----------------------------------------------------------- |
| `agents.maxConcurrent`  | `4`     | `1–8`   | Task agents running at once; further tasks queue.           |
| `agents.timeoutMinutes` | `10`    | `1–60`  | Hard deadline per task agent.                               |
| `agents.maxTurns`       | `24`    | `1–100` | Soft completed turn-cycle budget; agents wrap up beyond it. |

Set these values in the top-level `agents` object. See [Configuration](/docs/configs) for file locations and merge behavior.
