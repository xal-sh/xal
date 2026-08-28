# Background work

Background work comes in two vocabularies. A _background session_ is a whole session that keeps working after you leave the terminal: `/bg` hands the running conversation to a detached worker process and returns you to the shell. _Background jobs_ are work inside a live session: task agents dispatched with the `task` tool, processes started with `bash` `background:true`, and waits started by `scheduler`. Jobs are tracked per session and share one set of TUI surfaces. Agent and process results are delivered into the conversation automatically; a schedule resumes its waiting model turn directly.

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

Dispatching any `write` task asks for approval. Sub-agents cannot ask for approval themselves; any action that would need it is denied automatically. Each agent runs until it produces a final report, is explicitly stopped, or exceeds its turn budget: after `agents.maxTurns` completed turns the agent is told to wrap up, and at 1.5× the budget its last report is returned as-is instead of running forever. The primary agent can inspect and extend the soft turn budget while the task runs. `agents.timeoutMinutes` can add an operator-configured wall-clock safety limit, but its default value of `0` leaves agent lifetime unlimited and the primary agent cannot change it.

A task agent should work independently, but it can call `ask_parent` when a parent-only decision or missing context truly blocks useful progress. The tool suspends that child tool call and shows `Waiting for parent…` without starting another provider turn or polling. Each child can have one pending question. A configured task deadline bounds the wait; cancellation or parent failure also releases it with an unavailable result. Questions are process-local live state and are not resumed after teardown.

The parent receives a persisted, expandable question notice in the transcript and TUI plus a transient model instruction. It answers with `job_send`; while a question is pending, the next accepted `job_send` or TUI agent message is the answer rather than ordinary guidance. If the parent finishes without answering, it gets one transient correction. Finishing again releases the child as parent-unavailable. A question wakes `wait_agent` and an explicit `job_output(wait)` so the parent cannot deadlock while waiting for the blocked child. Historical question events remain visible after restart, but no actionable instruction is restored into provider history. Assignments should still be self-contained, and agents should not use this path for status questions.

A finished agent's report is delivered into the parent conversation automatically as a system notice, with no polling needed. If the active turn is blocked on agent work, `wait_agent` subscribes to task-agent activity and returns when a result or question is queued, new user input arrives, or its timeout expires. It does not collect or suppress the automatic report delivery. Alongside the in-conversation result, every agent writes two durable files into the session directory:

- a Markdown task record (`agent-<id>-….md`) with the assignment, workspace, final report, and buffered transcript
- a full transcript log (`agent-<id>-….log`) written incrementally while the agent runs, so nothing is lost even if the process dies; logs cap at 64 MB and are marked `(capped)` past that

## Background processes

`bash` with `background:true` starts the command as a managed job and returns its id immediately. Output is captured into a bounded in-memory buffer (oldest middle dropped past ~400 KB, marked with `... N characters omitted ...`) and written completely to a `.log` file in the session directory. When the process exits, its result is delivered into the conversation automatically.

A running foreground `bash` command can be promoted to a background job at any moment with the `jobs.background` shortcut (default `ctrl+b`). The command keeps running, its output keeps flowing into the job, and the result is delivered when it exits. Killing a promoted command that ran in the persistent shell tears the shell session down; the next command starts a fresh one.

## Job tools

The model coordinates jobs with six tools:

| Tool         | Purpose                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `wait_agent` | Wait for task-agent activity without collecting or consuming the automatically delivered report.                       |
| `job_output` | Read process output, collect an agent report, or inspect a schedule; configured deadlines add supervision checkpoints. |
| `job_status` | Inspect processes, task agents, and schedules without consuming output.                                                |
| `job_send`   | Answer a pending task-agent question, or queue guidance when no question is pending.                                   |
| `job_extend` | Add up to 100 soft-budget turns to a queued or running task agent per call.                                            |
| `job_kill`   | Stop a process, task agent, or schedule. A process that ignores the graceful stop is hard-killed after 2 seconds.      |

`wait_agent` defaults to 30 seconds, clamps shorter requests to 10 seconds, and accepts waits up to one hour. It ends early for queued task-agent results, task-agent questions, or new user input, and its timeout never stops an agent. An explicit `job_output` wait also returns without affecting agent execution. When an operator configures a nonzero runtime limit, `job_output` reserves a supervision window of up to one minute before the deadline and returns with live status so the parent can inspect, steer, or stop the task. If the configured runtime limit is reached, collection includes a bounded transcript tail labeled as incomplete alongside the durable task-record path.

Stopping a job from the TUI is never silent: the result is marked `stopped by the user` and still delivered so the model knows what happened. A task agent remains unsettled until its runner has finished cleanup and saved its task record.

## TUI surfaces

- The status bar shows live counts (`2 agents · 1 job · …`) whenever background work exists.
- Running agents are summarized above the composer by ID and elapsed time; queued agents show `queued <time>` until they start.
- The navigator at the bottom lists every process, task agent, and schedule: running rows first, then finished rows (newest first). Schedule rows show their remaining time. The full viewer shows live activity and timing, plus context, tool, and turn metrics for agents. Successfully completed agents are dismissed when the primary session returns to idle; failed agents and finished jobs remain reviewable until dismissed or evicted, and jobs started by a sub-agent are attributed with `⟨agent-id⟩`.
- Normal transcript mode shows a completed background result as its ID and first report line. Use `display.toggle-details` (default `ctrl+o`) to reveal its assignment, status, line count, report output, and record path.

Open the navigator with `/agents` (alias `/jobs`), the `agents.open` shortcut (default `ctrl+x ctrl+a`), or by pressing `↓` with an empty composer.

Navigator keys:

| Key       | Action                                                     |
| --------- | ---------------------------------------------------------- |
| `↑` `↓`   | Move between rows; `↑` from `main` returns to the composer |
| `enter`   | Open the viewer for the selected job                       |
| `tab`     | Toggle an inline preview of the last output lines          |
| `x` / `k` | Stop a running job, or dismiss a finished row              |
| `esc`     | Close the viewer, collapse the preview, or leave           |

The viewer takes over the screen and follows the job's output live. While it is open, `↑`/`↓` keep moving the selection in the list below and `enter` switches the viewer to the selected job (or closes it on the viewed row), so you can hop between running agents without leaving the viewer. `pgup`/`pgdn` scroll the transcript, `home` jumps to the top, and `end` returns to the bottom and resumes following (scrolling up pauses following and shows `· paused`). For a running agent, `i` opens a steering input, type guidance and press `enter` to queue it into the agent's current turn; the transcript marks it as `User guidance`.

`agents.stop-all` (default `ctrl+x ctrl+k`) stops every running agent at once.

## Configuration

Every field in the top-level `agents` object must be an integer and is validated strictly.

| Option                  | Default | Range   | Description                                                       |
| ----------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `agents.maxConcurrent`  | `4`     | `1–8`   | Task agents running at once; further tasks queue.                 |
| `agents.timeoutMinutes` | `0`     | `0–60`  | Optional hard deadline per task agent; `0` disables the deadline. |
| `agents.maxTurns`       | `24`    | `1–100` | Soft completed turn-cycle budget; agents wrap up beyond it.       |

Set these values in the top-level `agents` object. See [Configuration](/docs/configs) for file locations and merge behavior.
