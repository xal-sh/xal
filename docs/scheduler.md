# Scheduler

The built-in `scheduler` tool waits for a model-selected duration. When the wait completes, the tool returns to the same turn and the model receives another inference opportunity with the elapsed wall-clock time.

This supports time-based delays without running a shell sleep command. Repeating behavior remains model-driven: after each wait, the model can inspect current state, finish, or call `scheduler` again. Task-agent coordination uses the event-driven `wait_agent` tool described in [Background work](/docs/background-work).

## Arguments

`scheduler` accepts one field:

- `duration_ms`: integer duration in milliseconds from `1` through `43200000`, or 12 hours.

The tool is read-only. Each active wait is tracked as a `schedule-*` background job and appears in the TUI background-work panel with its remaining time. Focus the panel and press `x` or `k` to cancel the selected schedule. `job_status` can inspect schedules and `job_kill` can cancel them.

## Activity and interruption

Queued user input and completed background work end the wait early. The pending activity is then handled by the active turn.

Interrupting the turn also ends the wait.

## Process lifetime

A scheduled wait runs inside the active agent process, including a background worker while that worker remains active. It is not an operating-system cron service and does not survive application or worker process exit.
