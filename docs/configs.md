# Configuration

Configure Xal globally for your user or locally for one project. This page explains configuration files, merge behavior, and the top-level schema. Follow the links in the option table for detailed behavior and examples.

## File locations

The app name comes from `apps/cli/package.json`. In the paths and commands below, `<name>` means that package name. The app home defaults to `~/.<name>` and can be overridden with the environment variable formed by upper-casing the package name, replacing non-alphanumeric characters with underscores, and appending `_HOME`.

Xal reads JSON configuration from two locations:

| Layer   | Path                             | Priority |
| ------- | -------------------------------- | -------- |
| User    | `<app-home>/config.json`         | Lower    |
| Project | `<git-root>/.<name>/config.json` | Higher   |

Xal searches upward from the working directory for `.git`. When no Git root is found, the working directory is used as the project root.

Both files are optional and must contain a JSON object when present. Objects merge recursively from user to project configuration. Arrays and scalar values are replaced by the project value. Project configuration applies to every option, including plugins and permission rules, so it must be treated as trusted code and policy.

A project-root `.mcp.json` is a discovery source rather than a third configuration layer. On interactive launch, Xal can use its new MCP server names for the current process or copy them into either configuration file. Existing Xal server names are not overwritten. See [Project `.mcp.json` discovery](/docs/integrations#project-mcpjson-discovery) for the accepted schema and launch choices.

Commands that save model, thinking, context-window, compaction-limit, TypeSafe AI, or TUI display preferences write the user file. Xal then recomputes the effective configuration, and any project override remains active. Importing discovered MCP servers and deleting servers from `/mcp` are source-aware exceptions: project choices update the project file, global choices update the user file, and deletion updates the file that supplied the effective server.

Global memory is stored at `<app-home>/MEMORY.md`. On Unix, Xal creates it with mode `0600` and rejects broader permissions. Windows does not expose an equivalent mode through the filesystem API, so Xal relies on the inherited ACL of `<app-home>`. If the app home is overridden on Windows, its directory must be private to the current user.

## Top-level options

| Option             | Type       | Default                                     | Details                                                                     |
| ------------------ | ---------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `plugins`          | `string[]` | `[]`                                        | Additional modules described in [Plugins and hooks](/docs/plugins).         |
| `provider`         | `string`   | Last registered provider                    | Provider ID or alias used for new sessions.                                 |
| `profile`          | `string`   | Selected connection                         | Internal ID of the named provider profile used for new sessions.            |
| `model`            | `string`   | Provider default                            | Model ID used for new sessions.                                             |
| `ui`               | `string`   | `"tui"`                                     | UI ID started when Xal runs without a command.                              |
| `mode`             | `string`   | `"normal"`                                  | Permission mode used for new TUI and headless sessions.                     |
| `permissions`      | `object`   | `{}`                                        | Global rules described in [Permissions and security](/docs/permissions).    |
| `modes`            | `object`   | `{}`                                        | [Custom permission modes](/docs/permissions#custom-modes) keyed by name.    |
| `goal`             | `object`   | `{}`                                        | Evaluator models described in [Goals](/docs/goals).                         |
| `verification`     | `object`   | `{}`                                        | Named [verification checks](#verification-checks) and workspace evidence.   |
| `redaction`        | `object`   | `{}`                                        | [Sensitive values](/docs/permissions#redaction) to redact.                  |
| `agents`           | `object`   | `{}`                                        | Limits described in [Background work](/docs/background-work#configuration). |
| `providerTimeouts` | `object`   | See [Provider timeouts](#provider-timeouts) | First-event and idle limits for provider streams.                           |
| `pluginConfig`     | `object`   | `{}`                                        | Configuration keyed by plugin name.                                         |
| `thinking`         | `object`   | `{}`                                        | Thinking effort keyed by provider ID and model ID.                          |
| `contextWindows`   | `object`   | `{}`                                        | Context-window choices keyed by provider ID and model ID.                   |
| `compactionLimits` | `object`   | `{}`                                        | Auto-compaction limits keyed by provider ID and model ID.                   |
| `typesafeAI`       | `object`   | `{ "enabled": false }`                      | One switch for all [TypeSafe AI features](#typesafe-ai).                    |

The `profile` value is managed by `/connect` and `/model`. Profile names remain user-facing and may be renamed without changing this ID.

`mode` accepts `normal`, `plan`, `yolo`, or a name defined under `modes`. A command-line `--mode` overrides the configured default for that session.

Malformed `mode`, `permissions`, `modes`, `goal`, `verification`, `redaction`, `typesafeAI`, `agents`, or `providerTimeouts` configuration fails startup instead of silently running without those rules.

Built-in configuration is documented with the feature that consumes it:

- [TUI](/docs/tui) covers display preferences and keybindings.
- [Built-in tools](/docs/tools) covers the tools the model is offered and when each one is available.
- [Integrations](/docs/integrations) covers language servers and MCP servers.
- [Providers and models](/docs/providers) covers built-in provider options and model discovery.
- [Plugins and hooks](/docs/plugins) covers custom plugin configuration.
- [Commands and skills](/docs/commands-and-skills) covers project instruction limits.
- [Scheduler](/docs/scheduler) covers delayed model continuation.

## Provider timeouts

`providerTimeouts` bounds how long a provider stream can wait for its first event and how long it can remain idle between events:

```json
{
  "providerTimeouts": {
    "firstEventMs": 600000,
    "idleMs": 300000
  }
}
```

The defaults are 10 minutes for `firstEventMs` and 5 minutes for `idleMs`. Each value must be an integer from `1000` to `1800000` milliseconds, inclusive. Omitted fields keep their defaults; unknown fields and non-object sections are rejected. User and trusted project settings merge recursively, so a project can override either limit independently.

Choose higher values for slow models that take longer to produce their first event or pause during generation. See [Stream timeouts](/docs/providers#stream-timeouts) for timeout behavior and recovery.

## Verification checks

Configure named shell commands to record which checks actually ran and whether their workspace evidence is still current:

```json
{
  "verification": {
    "checks": {
      "test": "bun test",
      "typecheck": "bun run typecheck"
    }
  }
}
```

Checks are opt-in and never run automatically. Names must start with a lower-case letter and contain only lower-case letters, digits, hyphens, or underscores. Commands must be non-empty strings and distinct after trimming surrounding whitespace. Only `checks` and `gate` are supported under `verification`; invalid configuration fails startup. Standard recursive merging applies, so a project can override a command by name.

In the TUI, `/checks` refreshes the evidence and `/checks <name>` runs one command through the normal direct-shell permissions and hooks. Model-issued `bash` calls and `!` commands also record a check when the effective foreground command exactly matches a configured command. Chained or modified commands do not match. Configured checks run in a fresh shell at the session workspace, without earlier `cd`, exports, aliases, or functions; they cannot use `background: true` or be promoted to background jobs. Normal shell timeouts still apply.

Receipts persist in session history with the command, workspace, timestamps, actual process termination, and workspace fingerprint. Status is `passed` only for exit code zero with matching evidence, `failed` for an unsuccessful or unfinished run with current evidence, `not_run` when no matching receipt exists, and `stale` when evidence changed or is unavailable. A started rerun supersedes its previous receipt even if it never finishes. The start receipt is saved before launching the shell, and the finished receipt before post-command undo capture; receipt write failures stop the call rather than claiming a pass. Denied calls do not record execution. `/new` clears receipts; resumed and forked sessions retain receipts but recompute freshness when inspected. Turn completion includes a verification summary in the TUI and headless output; replayed summaries are historical, not a fresh check.

Set `verification.gate` to `true` to hold the model to its checks. Xal fingerprints the workspace when a turn starts. When the model is about to finish, including when it submits structured output, and the workspace fingerprint has changed while any configured check is not `passed`, Xal returns the turn to the model once with each check's status and asks it to run the checks covering its change, or to say which cannot pass and why. After that correction, the verification gate does not block again during the turn, so it cannot loop. Plugin completion gates can still request their own bounded repairs. Turns that leave the workspace unchanged, including read-only questions, are never gated. The gate needs captured workspace evidence at turn start, so it does nothing outside a Git workspace. It defaults to `false`.

For an enforced completion contract, set `verification.gate` to `"required"` with at least one configured check:

```json
{
  "verification": {
    "gate": "required",
    "checks": {
      "test": "bun test",
      "typecheck": "bun run typecheck"
    }
  }
}
```

In this mode, **every configured check** must have a fresh `passed` receipt before any model turn can complete, even if the turn leaves the workspace unchanged. It applies to primary and task agents, headless runs, and structured output. Existing fresh receipts can satisfy it without rerunning; assistant claims, explanations, missing runs, failures, stale receipts, and unavailable evidence cannot. Use this mode for workflows that require checks on every completion, not just workspace-changing turns. A non-Git workspace cannot satisfy it. `gate` accepts only `false`, `true`, or `"required"`; required mode with no checks fails configuration loading.

Xal sends the model each check's status and exact command and permits at most three verification repair continuations per turn, separately from the plugin completion-gate budget. Another unmet attempt fails the turn rather than accepting an unverified answer. Repairs still use normal tools, permissions, cancellation, and loop guards; Xal does not run commands automatically or override denials. Required evidence is checked after `beforeComplete` hooks and refreshed again after `turnEnd` hooks, just before recording success. If that final refresh is not passing, the turn fails immediately without rerunning completion observers. In headless mode, failures exit nonzero: JSON reports `status: "failed"`, JSONL emits `turn_failed`, and text output reports the error. A proposed response may already have streamed; only the terminal outcome establishes success.

Direct user shell commands (`!` and `/checks <name>`) and session-restart control remain ungated. You can run or diagnose a check independently without having to satisfy the entire contract. Failed and interrupted turns never become successful through verification. A required-gate failure also uses the existing goal-loop failure path rather than advancing the goal evaluator.

Freshness compares SHA-256 fingerprints before and after execution and again when inspected. It covers tracked and non-ignored files across the Git workspace, including untracked additions, deletions, executable bits, and symlink destinations. It does not track ignored files, installed dependencies, environment variables, external services, Git metadata, or the contents behind symlinks. Non-Git directories, unsupported entries such as submodule directories or non-UTF-8 filenames and symlink destinations, and read failures produce unavailable evidence, never a pass. Unsettled managed background work also prevents a fresh status. Fingerprints are observations, not atomic filesystem snapshots or proof that a command tested the intended behavior; use foreground, non-watch commands and rerun after relevant external changes.

## Code Mode

The built-in `code-mode` plugin offers an experimental, provider-independent `code_mode` tool for combining read-only tools and filtering their results before they enter model context. It is off by default and does not require TypeSafe AI or another provider connection.

Enable it in user configuration or trusted project configuration, then restart Xal:

```json
{
  "pluginConfig": {
    "code-mode": {
      "enabled": true
    }
  }
}
```

`enabled` is the only supported field and must be a boolean. Missing or `false` leaves the tool unregistered, with no added model-facing schema or JavaScript runtime initialization. Invalid fields or values report a plugin registration failure and leave Code Mode unavailable. Standard configuration merge rules apply; set `enabled` to `false` in the higher-priority project file to override a user setting.

The initial release permits only `read`, `glob`, `grep`, and `webfetch`, with ordinary per-call permissions and hooks. Runtime and call limits are fixed rather than configurable. See [Code Mode](/docs/tools#code-mode) for the JavaScript API, limits, local traces, and an example. Keep it opt-in while evaluating task success, token usage, and latency with your models; no particular saving is guaranteed.

## Thinking effort

Thinking preferences use this shape:

```json
{
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    },
    "deepseek": {
      "deepseek-flash": "max"
    }
  }
}
```

Supported effort values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Each provider and model may support only a subset. An unavailable saved effort is ignored in favor of that model's default. Saved preferences are resolved by canonical model ID first, then the requested alias, then other aliases in catalog order. `/thinking` and the thinking shortcuts save under the canonical ID; existing alias settings are not rewritten.

## Context windows

Context-window preferences use the same provider and model keys:

```json
{
  "contextWindows": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 600000
    },
    "openai": {
      "gpt-5.6-sol": 1000000
    }
  }
}
```

Use `/context-window` to save this preference for the current model. The command is available when a provider advertises multiple windows. Provider entries must be objects, and each model value must be a positive integer. A saved value that is no longer offered is ignored in favor of the model default.

## Compaction limits

Automatic-compaction preferences use fixed token counts for each provider and canonical model:

```json
{
  "compactionLimits": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 180000
    },
    "anthropic": {
      "claude-opus-4-6": 140000
    }
  }
}
```

Use `/compaction-limit` to choose a context-relative limit for the active model. The command offers fixed token values at 50%, 60%, 70%, and 80% of the active context window and saves the selected absolute value under the canonical model ID. It is available only when the model has a known context window.

Provider entries must be objects, and each model value must be a positive integer. Limits are resolved by canonical model ID first, then the requested alias, then other aliases in catalog order. A saved value takes precedence over a provider-advertised limit, but every effective limit is capped at 80% of the active context window. This cap also keeps a stale value safe when `/context-window` changes the model's active window.

Before automatic compaction asks a model to summarize, Xal tries local reductions: first superseded file reads, then older large tool outputs. The second pass saves text results larger than 4 KiB from `read`, `grep`, `glob`, `webfetch`, and `lsp` to private files and leaves recovery paths in their place. It keeps the last 12 tool calls' results and the entire latest tool-call batch, all user messages, assistant text, reasoning, and tool-call arguments. Failed results, images, and other tools' results stay intact. Shell results are excluded because their persisted history does not retain structured exit status; skills, memory, interaction, and MCP results are also excluded.

An output-offload checkpoint is used only when it reduces the estimated request by more than 25% and brings it below 90% of the effective compaction limit. It makes no provider request. Otherwise Xal uses its existing Jev or summary compaction on the original history. Manual `/compact` is unchanged. Known secrets are redacted before saving; save failures or cancellation leave the active history unchanged. Rejected or interrupted offload attempts remove their pending archives. Retrieve archived results rather than rerunning operations to recreate historical evidence. Offloading clears file-read authorization, so a later whole-file overwrite or `replace_all` needs fresh direct reads, just as after summary compaction. This behavior needs no configuration and uses the same compaction trigger above.

## TypeSafe AI

Run `/config` and press Enter on **Use TypeSafe AI** to flip it. `/config typesafe` opens an explicit On/Off choice with the data-sharing notice. This is the only feature switch:

- **On:** enables Jev compaction, [Jev read-ahead](#jev-read-ahead), and the model-facing [classify tool](#classification-tool).
- **Off** (default): hides `classify`, blocks TypeSafe inference, prefetches nothing, and uses ordinary summary compaction.

Search and selected thinking effort are unchanged in both modes. There is no Jev code search, reasoning routing, or Auto mode.

Connect TypeSafe using `/connect` first. With one connection, enabling needs only the On choice. Xal reuses the previously selected connection; when several connections exist without a valid selection, it asks which profile to use. Disconnecting a profile does not hide the switch. You can turn everything off without reconnecting. An enabled but disconnected profile produces a visible notice and falls back to ordinary summary compaction when compacting. Classification calls fail visibly without fallback.

```json
{
  "typesafeAI": {
    "enabled": true,
    "profile": "<immutable TypeSafe profile ID>"
  }
}
```

`enabled` must be a boolean. On requires a non-empty `profile` ID, not the profile name or API key. Off may retain that ID for the next enable. Unknown fields and malformed settings fail startup. Changes save to user configuration; trusted project configuration takes precedence. The choice can be changed when the session is idle and applies to current and new sessions, headless runs, resumed/forked sessions, and newly starting tasks. The shared decision service also rejects TypeSafe inference while Off or with a different profile than the selected one.

**Privacy:** Jev compaction sends a redacted text view of the active conversation, tool names and inputs, and the compaction focus to TypeSafe. Tool output bodies, images, and opaque provider replay data are omitted from that view. Jev read-ahead additionally sends the last three user prompts, the last assistant message, the triggering tool names and inputs or the new prompt, candidate file paths, and the result lines that mention each candidate. Prefetched file contents are never sent to TypeSafe, by read-ahead or by a later compaction. Conversation text, tool inputs, and search excerpts can still contain paths or code. Known-secret redaction is a safeguard, not a guarantee that every sensitive value is removed. Enable only for conversation data you may send to TypeSafe.

## Jev read-ahead

Most rounds in a coding session are exploration: the model greps, then reads, then reads again, and each round costs a full model request whose only purpose is choosing the next file. With TypeSafe AI On, the harness makes that choice itself and fetches the file before the model asks. There is no new tool and no configuration beyond the switch; read-ahead applies to primary sessions, task agents, and headless runs.

**After a tool batch.** When a batch of `read`, `grep`, or `glob` calls finishes, Xal collects the workspace file paths that appear in their results. A `read` result also yields the relative imports of the file just read, resolved with that file's extension and its `index` form. Paths already read in the active conversation, prefetched earlier, or read in the same batch are skipped, as are paths outside the working directory. At most 40 candidates are scored, packed into as few Jev requests as fit its state budget; each answer is the probability that the assistant needs to open that file for its next step. Candidates at or above 0.7 are fetched in descending order, at most four files and 24,000 bytes per batch, and appended to the last eligible result under a `[read-ahead] Prefetched <path> because the next step likely needs it:` marker followed by the ordinary `read` output. A file whose content would exceed the remaining budget is skipped rather than truncated. Nothing is prefetched for a result that was already bounded by the tool output limit, a failed call, or a denied call.

**At prompt time.** When a prompt is accepted, the same scoring runs over the workspace paths mentioned in the prompt plus the files that `git status` reports as changed, when the working directory is inside a Git repository. Selected files are appended to the text sent to the model; the prompt shown in the transcript is unchanged.

Prefetched files go through the registered `read` tool with the session's permission mode and rules. A path that would need approval, such as a `.env` file, is skipped without prompting, and so is a file the tool cannot read, such as a binary. Content passes through the secret redactor like any tool result. Lifecycle hooks do not observe prefetched reads, because no tool call is made. A turn that was stopped by the repeated-tool-loop guard does not run read-ahead. Prompt-time prefetches live only in the text sent to the model; the Jev compaction view strips them, so file contents never reach TypeSafe. The whole read-ahead is bounded to five seconds per trigger, including provider retries; a timeout, disconnected profile, Git failure, API error, invalid decision, or oversized candidate view produces a visible notice and prefetches nothing, and the model's own next call proceeds normally. Interrupting the turn drops the prefetch silently. TypeSafe usage is recorded under `read_ahead`.

**Migration:** the previous `compaction`, `codeSearch`, `reasoningRouting`, and `automaticThinking` settings are ignored. Existing `typesafeAI` choices remain valid. If you only have a legacy setting, enable **Use TypeSafe AI** once to use Jev compaction again. Saving this choice removes those legacy fields from user configuration; remove obsolete fields from project configuration manually. Existing `thinking` preferences and `compactionLimits` are unchanged. There are no separate feature toggles or `/thinking` Auto option. Older sessions remain readable; archived routing and request-metric events are not replayed, and historical TypeSafe usage remains included in usage totals.

## Classification tool

With TypeSafe AI On, the built-in `classify` plugin makes a general-purpose tool available to the model in primary and task sessions, including headless runs and plan mode. It does not modify project files. The model decides whether to call it; Xal does not require it during planning or review and does not insert a system-prompt instruction to prefer it. Normal tool permissions still apply.

### Parameters and answers

- `model` is optional: `jev-latest` selects the stable alias by default, `jev-preview` selects the newest release, and `jev-1.13.0` pins the current version. Both aliases currently resolve to 1.13.0 but can move. These are decision models, not harness chat models.
- `evaluations` contains 1 to 100 independent units, each with a unique `id`, a `state` (text, JSON object, or array), and a non-empty `questions` map. Supply the relevant evidence, such as requirements and a plan, or a diff hunk and surrounding code. Jev cannot access the conversation, read files, or fetch missing context itself.
- Every question has a `type` and `instructions`. Question IDs only identify returned answers; Jev does not see them. Put the complete question in `instructions`, using backticked field paths when helpful. Instructions and descriptions can be strings, structured objects, arrays, or null.
- `noul` returns the probability of yes, from 0 to 1. Optional `criteria.true` and `criteria.false` describe the boundary. It has no separate confidence; 0.5 means uncertainty, not medium intensity.
- `choice` requires `criteria` mapping at least two option names to descriptions. It returns the selected option, all option probabilities, and confidence. Supply a no-match option when the listed alternatives may not cover the input.
- `score` requires an ordered `criteria` array of at least two descriptive levels. It returns a probability-weighted score from 0 to N-1, potentially fractional, plus the legend, distribution, and confidence. Separate dimensions such as readability and security belong in separate questions.

Example tool arguments:

```json
{
  "model": "jev-latest",
  "evaluations": [
    {
      "id": "plan",
      "state": {
        "requirement": "Expired sessions must not authorize requests.",
        "plan": "Check expiry before authorization and test expired sessions."
      },
      "questions": {
        "coverage": {
          "type": "noul",
          "instructions": "Does `plan` explicitly address the expired-session condition in `requirement`?"
        },
        "test_specificity": {
          "type": "score",
          "instructions": "How specific is the proposed validation in `plan`?",
          "criteria": ["No validation stated", "Names a test scenario", "Names a scenario and expected outcome"]
        }
      }
    }
  ]
}
```

The result contains `evaluations`, each with its original `id`, merged `answers`, and `batches` listing actual model versions, question IDs, and provider token usage. Top-level `requests` counts completed batches, excluding transport retries. Large outputs use the harness's normal preview and saved full-output path.

Confidence measures certainty among the supplied alternatives, not proof that a plan or code is correct or secure. Jev returns classifications, not explanations, fixes, or a formal verification. Xal supplies no built-in rubrics, weights, thresholds, or automatic actions. The caller retains responsibility for interpretation and validation. Adversarial text can influence classifications; clear criteria and relevant evidence help but do not make the result a security boundary.

### Large inputs and consecutive requests

Current [Jev model documentation](https://docs.typesafe.ai/models) specifies 64k tokens for the whole request and 32k for state plus the longest question. Xal conservatively counts each serialized UTF-8 byte as one estimated token, including JSON overhead, and targets 60,000 overall and 30,000 for state plus each question. This deliberately underuses the window for typical text; it is not Jev's tokenizer or a guarantee about future alias versions.

Questions sharing a state are packed into requests automatically. Every batch receives the same complete, redacted state, and answers are merged by question ID without changing their values. All evaluations are validated and sized before inference. An oversized individual state or question fails with guidance to split it into meaningful units with the context each needs. Xal never silently truncates content, slices code, averages confidence, or fabricates a whole-input verdict from chunk results.

Evaluation units and their batches run consecutively, with at most 100 planned requests and a five-minute inference deadline per tool call. Provider retries retain their existing per-request limits. Cancellation stops further work. Errors stop the call with a visible failure rather than a partial success or fallback; already completed requests remain included in TypeSafe usage. Separate calls can handle larger workloads.

Questions within a request are independent and cannot see one another's answers. Evaluation units also do not inherit earlier results. If a judgment depends on an earlier answer, make a subsequent `classify` call that explicitly includes that answer and any new evidence in its state. There is no hidden cross-call memory.

**Privacy:** classification sends the model-supplied states, instructions, and criteria to TypeSafe, including any code, paths, or copied tool output supplied in those fields. Known secrets are redacted, but unrecognized sensitive content may remain. Unlike compaction's restricted transcript view, this tool does not omit tool-output text that the caller explicitly includes. Enable only for material you may send to TypeSafe. Calling the tool incurs TypeSafe API usage on the selected profile.

## Jev compaction

Enabled by the [TypeSafe AI switch](#typesafe-ai) for manual `/compact` and automatic compaction, including task-agent sessions. It does not change the existing `compactionLimits` trigger. Off uses ordinary summary compaction.

Enabling this sends structured state to TypeSafe's `jev-latest` with `context`, `goal`, and `history`. The context explains that pruning frees space for the assistant to continue its task while preserving requirements, decisions, and information needed for unfinished work. The goal is the explicit `/compact` focus when non-empty; otherwise it uses the last three non-empty user prompts in chronological order, each limited to 500 UTF-8 bytes with an omission marker when shortened. History contains an indexed text view of the active conversation, tool names and inputs. Tool results are represented by their lengths, images by omission notices, and opaque provider replay data is excluded. Long inputs and older text may be shortened in the decision view only. Xal conservatively targets 25,000 estimated state tokens and 30,000 estimated total tokens per request, batching questions as needed. Every batch receives the same context, goal, and fitted history. These are estimates, not a tokenizer guarantee.

Jev scores whether older tool calls and their results should stay. A result probability of at least 0.5 keeps both; otherwise a call probability of at least 0.5 keeps the call and truncates long results to 300 characters plus a notice; otherwise both are removed. The first conversation item and the newest six items are protected, including either half of any tool pair touching those items. User and assistant text, images, and retained provider replay data remain unchanged in the saved history. Before pruning, Xal archives the redacted active source transcript as private JSONL. The `jev_v1` checkpoint reloads the retained history with a recovery notice pointing to that archive, not a generated summary. Shortened results direct the model to historical evidence rather than asking it to rerun potentially state-changing tools; shortened read results lose their coverage metadata.

Pruning is accepted only when it reduces the estimated full harness request by more than 25% and leaves it below 90% of the active auto-compaction limit, when known. Unavailable credentials, API errors, invalid decisions, an oversized decision view, or insufficient reduction produce a visible fallback notice, then run ordinary summary compaction against the original history. No partial Jev edits are applied. User cancellation stops without fallback or history replacement. The whole Jev attempt is bounded to 60 seconds. Successful decision requests are included in TypeSafe's compaction token usage.

This is inspired by [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), adapted to Xal's conversation and persistence contracts without importing its Claude-specific message format.

## Combined example

Every option is optional. This example shows how the top-level sections fit together. Each linked feature page documents its complete nested schema.

```json
{
  "plugins": ["/absolute/path/to/example-plugin"],
  "provider": "openai-chatgpt",
  "model": "gpt-5.6-terra",
  "ui": "tui",
  "mode": "normal",
  "permissions": {
    "allow": ["bash(git status*)"],
    "ask": ["bash(git push*)"],
    "deny": ["bash(rm -rf /*)"]
  },
  "modes": {
    "paranoid": { "ask": ["*"] }
  },
  "goal": {
    "evaluatorModels": {
      "openai-chatgpt": "gpt-5.6-terra"
    }
  },
  "redaction": {
    "environment": ["MY_PROJECT_TOKEN"]
  },
  "agents": {
    "maxConcurrent": 4,
    "timeoutMinutes": 0,
    "maxTurns": 24
  },
  "thinking": {
    "openai-chatgpt": {
      "gpt-5.6-terra": "high"
    }
  },
  "contextWindows": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 600000
    }
  },
  "compactionLimits": {
    "openai-chatgpt": {
      "gpt-5.6-terra": 180000
    }
  },
  "pluginConfig": {
    "tui": {
      "showOutputs": false,
      "showThinking": false,
      "scrollbackRows": 1000
    },
    "project-instructions": {
      "maxBytes": 65536
    },
    "example-plugin": {
      "enabled": true
    }
  }
}
```
