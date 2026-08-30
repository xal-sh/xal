# Commands and skills

Reuse common instructions through project guidance, lightweight Markdown prompt commands, or richer skill packages that the model loads on demand.

## Project instructions

Xal discovers `AGENTS.md` files and adds their guidance to the model prompt. `pluginConfig.project-instructions.maxBytes` controls the maximum combined UTF-8 byte budget for the discovered files. It must be a positive integer and defaults to `32768`.

```json
{
  "pluginConfig": {
    "project-instructions": {
      "maxBytes": 65536
    }
  }
}
```

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

## Context compaction

`/compact [focus]` summarizes the complete active conversation and atomically replaces it with a provider-neutral checkpoint. New checkpoints retain only the newest authored user requests, without images, within a 20,000-token ceiling; the authoritative continuation summary follows them. The complete replacement request, including instructions and tools, must fit an estimated 32,000-token budget. Assistant output, reasoning, tool calls and results, direct-shell output, provider replay, and synthetic notices are summarized but never retained directly. If summary generation is interrupted, empty, fails, or cannot fit the replacement budget, the original history remains unchanged.

Before every normal provider request, Xal drains queued prompts, background results, and pending agent questions, then estimates the complete request including system instructions and tool schemas. At 80% of the selected model's context window, or an earlier saved or provider-declared limit, Xal compacts and rechecks a freshly built request. `/compaction-limit` saves a fixed limit for the active canonical provider/model when its context window is known. Automatic compaction retries once only when a retryable provider failure occurs before any response event. If required compaction still fails, or the rebuilt request reaches the model's hard context window, the turn fails without sending the normal request.

Version-2 sessions remain compatible. Existing checkpoints without a strategy keep their original summary-first retained-tail ordering when loaded. Their next successful compaction writes the new `user_messages_v1` format; loading alone never rewrites session data.

Compaction uses the conversation model's low-effort fast variant when available. Its complete semantic history projection removes opaque provider replay payloads while preserving assistant text, reasoning summaries, tool calls, and tool results. The summary request disables tools and omits their schemas because it cannot call them; its cache identity is recomputed from that exact prompt. This keeps the checkpoint provider-neutral without paying to resend unusable schemas or encrypted transport state.

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
