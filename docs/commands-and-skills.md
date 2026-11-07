# Commands and skills

Reuse common instructions through project guidance, lightweight Markdown prompt commands, or richer skill packages that the model loads on demand.

## Project instructions

Xal discovers `AGENTS.md` files and adds their guidance to the model prompt. At startup it loads every `AGENTS.md` from the project root down to the working directory. `pluginConfig.project-instructions.maxBytes` controls the maximum combined UTF-8 byte budget for those files. It must be a positive integer and defaults to `32768`.

Nested `AGENTS.md` files below the working directory, or in other branches of the project, are loaded when a session first uses a file under them. Using a file means a successful `read`, `edit`, or `write`, including reads inside Code Mode programs. From the next model request on, that session's prompt adds each newly found file after the startup instructions, nearer directories last, so they take precedence. Nested files have their own budget of `maxBytes`. They persist through compaction and are cleared by `/new`. Files outside the project root never load nested instructions. Adding a nested file changes the system prompt, which invalidates the provider prompt cache once.

```json
{
  "pluginConfig": {
    "project-instructions": {
      "maxBytes": 65536
    }
  }
}
```

## Workspace context

Before a session's first turn, Xal adds the local date and a Git snapshot to the end of the model prompt: the branch, up to 20 changed or untracked paths in `git status --short` notation with a count of the rest, and the last five commit subjects. Untracked directories appear as one entry, as in `git status`. Outside a Git repository only the date is added, and if Git cannot run, the prompt says why. The snapshot is taken once per session workspace and labeled as taken at session start, so it does not change the system prompt or invalidate the provider prompt cache while the agent edits files. Entering or leaving a worktree takes a new snapshot on the next turn.

## Prompt commands

Xal discovers reusable Markdown prompt commands from two directories:

| Scope   | Path                               | Priority |
| ------- | ---------------------------------- | -------- |
| User    | `<app-home>/commands/*.md`         | Lower    |
| Project | `<git-root>/.<name>/commands/*.md` | Higher   |

A project command replaces a user command with the same filename. Command filenames become slash-command names and must use lower-case letters, numbers, hyphens, or underscores. Prompt commands cannot replace built-in or plugin-registered commands.

Each file contains the prompt sent to the active session. Optional frontmatter supplies its command-palette description and argument hint:

```md
---
description: Review the current changes
argument-hint: <base-branch> [focus]
---

Review the current diff against $1. Pay particular attention to $2.

Additional context: $ARGUMENTS
```

`$1`, `$2`, and later numbered placeholders expand to positional arguments. `$ARGUMENTS` expands to all arguments joined with spaces, and `$$` emits a literal dollar sign. Missing positional arguments expand to an empty string.

After startup, type `/` in the TUI to see discovered commands in the command palette. Selecting one submits the expanded prompt through the same session path as a typed message.

## Verification checks

`/checks` refreshes the status of configured checks without running them. `/checks <name>` runs one named check through the regular direct-shell permission and hook flow. Both commands require an idle session. Receipts distinguish current passes and failures from missing or stale evidence; they do not gate completion. See [Verification checks](/docs/configs#verification-checks) for configuration, persistence, and freshness limits.

## Context compaction

The behavior below describes the default summary strategy. Connected TypeSafe users can opt into [Jev pruning through `/config`](/docs/configs#jev-compaction) for both `/compact` and automatic compaction, with visible fallback to the default strategy when necessary.

Every compaction first tries a free local step: it removes superseded file reads. Typed result metadata records the canonical path, content hash, actual displayed line range, and line truncation. A read is superseded only when a later untruncated result of the same file version covers that displayed range. Omitted arguments do not imply a full read; later writes, different versions, partial ranges, and results without coverage metadata cannot erase earlier evidence. Each superseded result is replaced with a short notice and its call is kept. Everything else stays verbatim. As with Jev, the result is accepted only when it reduces the estimated request by more than 25% and leaves it below 90% of the auto-compaction limit. An accepted result is saved as a `stale_reads_v1` checkpoint that reloads the pruned history without a summary. Otherwise nothing is changed and compaction continues with Jev, when enabled, or the summary strategy.

`/compact [focus]` summarizes the complete active conversation and atomically replaces it with a checkpoint. Before Jev or summary compaction, Xal saves the redacted active source transcript as private JSONL and puts its recovery path in the replacement context. New summary checkpoints retain the newest authored user requests, without images, within a 20,000-token ceiling, followed by an explicitly fallible continuation summary and, when it fits, the most recent complete tool exchange. That exchange keeps its original call/result IDs and associated assistant/reasoning items within an 8,000-token ceiling. The complete replacement request, including instructions and tools, must fit an estimated 32,000-token budget, reduced to 80% of the model's context window when that is smaller; these component ceilings share that budget. The archive preserves exact historical evidence, including original artifact pointers, without rerunning tools. If archival or summary generation fails, is interrupted, is empty, or cannot fit the replacement budget, the original history remains unchanged.

Before every normal provider request, Xal drains queued prompts, background results, and pending agent questions, then estimates the complete request including system instructions and tool schemas. At 80% of the selected model's context window, or an earlier saved or provider-declared limit, Xal compacts and rechecks a freshly built request. `/compaction-limit` saves a fixed limit for the active canonical provider/model when its context window is known. Automatic compaction retries once only when a retryable provider failure occurs before any response event. If required compaction still fails, or the rebuilt request reaches the model's hard context window, the turn fails without sending the normal request.

When a provider explicitly rejects an otherwise-admitted request because its input exceeds the context window, Xal tries compaction and retries the rebuilt request once. This applies to primary and task-agent sessions, only before any provider output event. A second rejection, a failure after partial output, or an unrelated authentication, rate-limit, output-limit, or validation error does not trigger this recovery. Completed tool calls are not executed again.

If the full summary request itself exceeds local admission or is explicitly rejected for context overflow before any output event, Xal makes one fallback summary request using an abridged text-only transcript excerpt. The excerpt keeps the beginning and end, marks omitted middle content, and is limited to 32,000 UTF-8 bytes or one byte per token in the known context window, whichever is smaller. It uses dedicated summary instructions, no tool schemas or images, and an output allowance of up to 4,000 tokens, reduced to fit the estimated remaining window. This fallback does not preserve the parent's cache prefix. The complete redacted transcript is archived before fallback; the resulting checkpoint explicitly warns that the summary is incomplete and includes the archive path for recovering exact evidence. If fallback fails, is interrupted, or cannot fit the replacement budget, the original history remains unchanged. Recovery is bounded rather than a guarantee: an oversized static prompt or an unrecognized provider error still fails visibly.

Version-2 sessions remain compatible. Existing checkpoints without a strategy keep their original summary-first retained-tail ordering when loaded. Their next successful summary compaction writes the `user_messages_v1` format, whose optional `tail` stores the recent complete exchange; loading alone never rewrites session data.

Summary compaction stays on the conversation model at low effort. It preserves the parent's system instructions, tool schemas, compatible conversation/replay prefix, and cache identity, then appends the summary request. Tool choice is explicitly disabled, and the auxiliary collector rejects returned tool calls independently; preserving schemas never authorizes execution. The output allowance is up to 12,000 tokens, reduced to the estimated space remaining in the selected model's known context window. The complete auxiliary request must fit with that allowance before streaming begins. Supported transports send that output cap; ChatGPT subscription transport instead relies on a local text safety limit and cancellation because it does not send the API output-limit field. The local limit is not a billed-token guarantee. These choices preserve reusable prompt structure, but cache hits and cost savings still depend on the provider and are not guaranteed.

## Token usage

`/usage [daily|weekly|cumulative] [provider]` opens an Escape-dismissable token activity dashboard. The view and provider arguments may appear in either order, `day` and `week` are accepted as view aliases, and omitting the view opens the daily heatmap. Omit the provider to include every provider, or pass a provider ID or alias to filter the complete dashboard. The `openai` filter combines OpenAI Platform API and ChatGPT subscription records; use `openai-api` for only Platform API usage or `chatgpt` for only ChatGPT usage. The chart covers 52 local calendar weeks whenever they fit; very narrow terminals label and show the most recent weeks that fit. Weekly bars group each calendar week and cumulative bars show the running total.

The default metric is total provider-processed tokens: input, including cache reads and writes, plus output. This reflects the full amount handled per provider request and avoids underreporting cache-heavy sessions. Press Left or Right to switch views, `D`, `W`, or `C` to select one directly, and `M` to toggle the chart and primary totals to uncached usage, which subtracts cache-read input. The dashboard shows explicit Today and Yesterday totals using the machine's local calendar dates, plus both total and uncached lifetime usage, cache-read share, request count, peak day, and current and best activity streaks.

Session totals include normal turns, compaction, and goal evaluation requests associated with the active session. Last 7d is the rolling previous seven 24-hour periods from now. Lifetime and chart totals cover usage recorded locally by Xal across all projects, not provider account quotas or billing history. Older version-1 ledger records contribute to Last 7d, Lifetime, and chart data but predate session grouping. See [Local usage dashboards](/docs/integrations#local-usage-dashboards) for the ledger format and storage location.

## Skills

Xal discovers reusable skill packages from four directories, in increasing priority:

| Scope   | Path                                    |
| ------- | --------------------------------------- |
| User    | `~/.agents/skills/**/SKILL.md`          |
| User    | `<app-home>/skills/**/SKILL.md`         |
| Project | `<git-root>/.agents/skills/**/SKILL.md` |
| Project | `<git-root>/.<name>/skills/**/SKILL.md` |

A later package replaces an earlier package with the same skill name. Project skill directories are read only after workspace trust is established.

Every package is a directory containing a `SKILL.md` entry file. The entry file requires YAML frontmatter with a `description`. Its `name` is optional and defaults to the package directory name:

```md
---
name: review-changes
description: Review the current workspace changes for correctness
---

Inspect the current diff, validate every finding, and report only actionable issues.
```

Skill names may contain up to 64 characters. Lower-case, hyphen-separated names remain recommended because they work naturally with `$skill-name` references. Xal normalizes metadata whitespace, accepts descriptions of any length, and repairs common third-party YAML mistakes such as unquoted prose containing colons. Unknown frontmatter fields are ignored, and the Markdown body may be empty.

Only skill names and up to the first 160 characters of each normalized description enter the system prompt. Lead with concise matching criteria; put procedures and edge cases in the skill body. The model loads full instructions on demand with the read-only `skill` tool, which can also read referenced text files inside that package without allowing paths to escape the package directory. `SKILL.md` files are limited to 64 KiB and supporting files read through the tool are limited to 50,000 bytes. A structurally invalid `SKILL.md` is skipped and reported as a startup warning without blocking other skills from loading.

Type `$` anywhere in the TUI composer to open skill completion. Continue typing to filter, then press Tab, Right, or Enter to replace only the skill reference at the cursor. Known `$skill-name` references are highlighted both while editing and in the submitted user message.

A prompt beginning with `$skill-name` explicitly invokes that skill. Xal keeps the compact original prompt visible in the conversation while sending the full skill instructions and the remaining user input to the model. A `$skill-name` reference later in a prompt remains ordinary user text, matching the behavior of other inline references. Skills do not register slash commands or appear in `/` completion.
