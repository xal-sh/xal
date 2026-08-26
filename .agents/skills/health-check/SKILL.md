---
name: health-check
description: Analyze a Xal profiler file (~/.xal/profiler/*.jsonl) to extract harness bugs, hidden failures, and performance problems from a profiled run.
---

# Profile Health Check

Xal records a profile when launched with `--profile`. The goal of this analysis is to find real harness bugs that the model may have masked by recovering: a failed tool, a dead subagent, or a swallowed provider error can look like a successful session because the model routed around it.

## Input

- The user input is the path to a profiler file. If empty, use the newest file in `~/.xal/profiler/`.
- Profiler filenames are random run identifiers and do not expose or map to a real session ID. Use only the anonymous labels in the profile unless the user separately supplies a session file.

## File format

One JSON object per line, ordered by time. Every line has `atMs` (elapsed milliseconds from process start) and `type`:

- `run_started` `{version}` — one profiled app process began.
- `session_created` `{session, kind, provider, model, thinking?}` — `kind` is `primary` or `subagent`; all string identities are run-local anonymous labels.
- `agent_event` `{session, kind, event}` — one non-streaming AgentEvent from `apps/cli/src/agent/events.ts`. Text, paths, IDs, arguments, outputs, and summaries are projected to counts or omitted. Settled assistant and reasoning events preserve only their type.
- `provider_request_started` `{request, session, kind, phase, provider, model, thinking?, attempt}` — one provider attempt. `phase` is `turn`, `compaction`, or `goal_evaluation`; retries have increasing attempts and distinct request labels.
- `provider_request_shape` `{request, shape}` — numeric input counts and estimates for that exact attempt, with instruction bytes, tool and schema counts, and no content.
- `provider_first_event` `{request, event, elapsedMs}` — the first provider event of any kind. Requests that fail before an event have no matching record.
- `provider_request_finished` `{request, outcome, elapsedMs, usage?}` — completion of that exact request. `outcome` is `completed`, `failed`, or `interrupted`.
- `tool_batch_started` `{batch, session, kind, concurrency, count, tools}` — one scheduler batch. `concurrency` is `shared` or `exclusive`; tools are anonymous labels in call order.
- `tool_batch_finished` `{batch, outcome, elapsedMs}` — completion and total scheduler duration, including permission and execution time.
- `tool_output_shape` `{session, kind, tool, shape}` — original and visible byte counts, visible token estimate, and bounding status without output text.
- `compaction_shape` `{session, kind, shape}` — trigger, strategy, outcome, numeric context and retention estimates, and removed item counts without a summary.
- `app_event` `{event}` — plugin registration and bootstrap results.
- `job_created` / `job_finished` use an anonymous `job` label and a structural outcome only.

## Failure markers

Extract every occurrence of these; they are the bugs and incidents:

- `turn_failed` — the turn died. The anonymous profile preserves usage and context but intentionally omits its message. If no `retry_scheduled` appeared earlier in the same turn, the error was classified non-retryable or arrived mid-stream.
- `provider_request_finished` with outcome `failed`. Join it to `provider_request_started` by `request`, then check whether a later attempt recovered. An interrupted request is only a failure when no user interruption explains it.
- `tool_batch_finished` with outcome `failed`. Join it to `tool_batch_started` by `batch` and inspect the anonymous tool events in that interval.
- `tool_finished` with a `denial` field (`user`, `policy`, `plan`, or `hook`). Output text and failure prefixes are intentionally unavailable; use batch outcome and surrounding turn records.
- `job_finished` whose outcome is `failed`, `interrupted`, or `timed_out`.
- `hook_finished` with action `failed` or `blocked`.
- `error` events — a non-fatal error was surfaced to the user; its text is intentionally omitted.
- `app_event` whose nested `event.failedPhases` is non-empty.
- A `user_message` whose turn never reaches `turn_ended` — the turn failed or was interrupted.

## Masked failures

The most valuable findings are failures the model recovered from. After listing raw failures, check what happened next:

- A denied or failed tool followed by the model reaching the same goal another way — capability gap or bug, even though the session succeeded.
- A failed sub-agent job whose task the primary session then redid itself.
- Repeated denials of the same tool in read-only sub-agents — the delegation may lack a capability it legitimately needs.
- Repeated failed tool batches or repeated anonymous tool labels can indicate a loop, but output-based loop-steering text is intentionally unavailable.

## Performance

- Tool duration is available for batches, not individual calls, because call IDs and event timestamps are not recorded.
- Provider latency: use `provider_first_event.elapsedMs` for time to first event and `provider_request_finished.elapsedMs` for total request time. Report requests with no first event separately instead of dropping them.
- Provider load: join request lifecycle and shape records by `request`, split `turn` from `compaction`, and compare model, thinking, attempt, outcome, usage, numeric request shape, first-event latency, and total duration. `totalInputTokens - cacheReadInputTokens` is uncached prefill; a jump to roughly the whole context is a prompt-cache miss.
- Compaction: report its request count, input/output usage, first-event latency, and total time independently from normal turns. Confirm it used the intended cheaper model and thinking effort.
- Batch utilization: join batch records by `batch`; report total batches, singleton batches, shared batches with more than one call, exclusive batches, maximum batch size, anonymous tool mix, and duration outliers. A high singleton share means the provider mostly emitted one call per round or exclusivity boundaries prevented grouping; it does not by itself mean the scheduler lacks batching.
- Turn duration: `user_message` to `turn_ended`; token usage and context size are only on `turn_ended`.
- Approval wait: measure from `approval_requested` to the next compatible `tool_started` or denied `tool_finished` in that session; exact call matching is unavailable.
- Flag outliers, not averages: the slowest tools, the longest waits, turns that burned tokens without progress.

## Report

- Findings ordered by severity. Each one: what happened, evidence (`atMs` and anonymous record labels), and a root-cause hypothesis pointing into the Xal source when possible.
- Separate three categories: Xal bugs, provider or environment issues, and model behavior issues.
- End with a verdict: did the harness work this run, and what should be fixed first.
