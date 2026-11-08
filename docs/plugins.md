# Plugins and hooks

Extend Xal with trusted in-process plugins that can register tools, providers, UIs, commands, and lifecycle hooks.

## Loading plugins

The top-level `plugins` array tells Xal what to load. It does not install or download anything. Every referenced plugin must already exist and be resolvable when Xal starts.

Each entry supports one of these forms:

- An installed package or module specifier, passed directly to Bun's module loader.
- A relative directory beginning with `.`, resolved from the app home directory and expected to contain `plugin.ts`.
- An absolute directory expected to contain `plugin.ts`.

```json
{
  "plugins": ["/absolute/path/to/my-plugin"]
}
```

The referenced directory must contain a `plugin.ts` whose default export has a `name`, a synchronous `register` function, and optionally asynchronous `bootstrap` and `shutdown` functions. Relative plugin paths are not resolved from the project directory, even when declared in project configuration.

Plugin registration is transactional. If importing, validating, or registering a plugin fails, Xal records a plugin registration failure and keeps none of that plugin's contributions.

## Model-facing context

Xal's built-in system prompt carries two things: session state, and behavioral policy. Session state is identity, current environment, permission mode, and stateful workflows the user explicitly entered, such as plan mode. Behavioral policy is how the agent is expected to work, covering execution, code changes, verification, and the shape of its replies; the change sections are withheld in read-only modes, where they do not apply.

Tool contracts stay out of the prompt. Tool definitions reach the model through the provider's native tool schema, and a tool description should explain capability, inputs, effects, limits, preconditions, and failure conditions; it should not restate general workflow that belongs in the prompt.

Plugins may contribute system-prompt sections with `ctx.registerPrompt`. Reserve these for runtime state, an explicitly enabled mode, or instructions intrinsic to the plugin as a whole. Do not use them to restate a tool's contract, which the tool description already carries. Project `AGENTS.md` files, the compact skill catalog, and global memory are intentional prompt contributions because the user enabled those context sources. MCP server instructions stay deferred until a search loads tools from that server. Prompt hooks can replace individual user messages and therefore remain a separate, explicitly trusted extension point.

## Lifecycle

`ctx.runtime` exposes the app name and version, app home and cache paths, profile-aware credential loading, saving, and compare-and-swap replacement, plus transient secret protection. Credential operations require both the provider ID and immutable profile ID. Provider plugins should use this runtime instead of reading or rewriting Xal's shared credential file directly. Provider model discovery and streaming also receive the profile ID, while `connect` returns a credential for the core to store under the user-provided profile name.

Plugins can contribute slash commands with `ctx.registerCommand`. Commands known synchronously belong in `register`; commands discovered from files or services may be added during `bootstrap`, before interactive input is released.

When the UI or CLI exits, Xal aborts `ctx.signal` so in-progress bootstrap work can stop, waits for bootstrap to settle, and then runs `shutdown` in reverse plugin order. Plugins that own child processes or network connections close them there. A dynamically discovered tool can be removed with `ctx.unregisterTool(tool)` using the same tool object that was registered. Tools that retain resources for an agent session can register per-session cleanup with `ctx.registerToolSessionDisposer`. State that is only valid while earlier tool results remain in the model's context, such as recorded file reads, can register `ctx.registerToolContextDisposer`; it runs when compaction, rewind, or redo replaces the conversation. It does not run for a stale-read pruning checkpoint, which keeps the latest result of every tool call that touched each file.

Tools that save their own output may return `outputSaved: true` alongside an output preview ending in `Full output saved to: <path>` or `Partial output saved to: <path>`. Set this only after successfully closing the artifact. The harness can then shrink that preview without saving a second artifact containing only the first preview. This transient execution metadata is cleared when redaction or a hook changes the returned text; it is not restored from transcript text.

## Hooks

Plugins register trusted lifecycle hooks with `ctx.registerHook`. Hooks run in built-in and configured-plugin order. Multiple hooks for the same event run sequentially, and a replacement from one hook becomes the input to the next.

| Handler          | Input                                                | Allowed result                                              |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `prompt`         | Model-facing prompt text and image count             | Replace the text or reject the prompt                       |
| `beforeTool`     | Tool name, call ID, and JSON arguments               | Replace the arguments or block the call                     |
| `afterTool`      | Tool details and its model-facing output             | Replace the output                                          |
| `beforeComplete` | Proposed final output, usage, and continuation count | Allow completion or block it with feedback for the model    |
| `turnEnd`        | Final output and token usage when available          | No result; use it for lifecycle automation or observability |

Every handler also receives a context containing an abort signal and the session ID, kind, working directory, provider, model, and permission mode. Prompt changes affect what the model sees while the TUI keeps the user's original text. Tool argument changes happen before scheduling, argument validation, and permission evaluation, so Xal validates, authorizes, and records the effective action. A hook that adds an argument the tool does not declare makes the call fail validation. Post-tool hooks also run for failed or interrupted executions, but not for calls blocked before execution.

Hook failures stop prompt, pre-tool, completion-check, and turn-completion processing. A post-tool failure becomes a failed tool result that warns the model the tool may already have changed state. Hook inputs and code run inside Xal's process, so only load hooks you trust. Returned text and arguments pass through secret redaction before they reach the model, session storage, or TUI.

### Hook deadlines and cancellation

Every handler invocation has a 60-second deadline. Set `timeoutMs` on the registered hook to override it for that hook's handlers; it must be an integer from `1` to `600000` milliseconds (10 minutes). Omission uses the default; `null`, zero, fractions, and values outside the range reject plugin registration. The budget restarts for each invocation, not for each event chain or turn.

```ts
ctx.registerHook({
  name: "validation",
  timeoutMs: 120000,
  async beforeComplete(input, ctx) {
    await validateHandoff(input.output, ctx.signal)
  },
})
```

Xal stops waiting on `prompt`, `beforeTool`, `beforeComplete`, and `turnEnd` when the turn is cancelled, even if the handler ignores its signal. `afterTool` still runs for interrupted executions and may finish its output processing within its deadline; its context signal still carries the turn's cancellation. Programmatic tool dispatch can stop waiting on post-tool processing earlier when its own scope is cancelled.

A timeout is a named hook failure, never approval or a completion-gate repair request. Later hooks in that event chain do not run. Post-tool timeouts use the ordinary failed-tool-result path, warning that the tool may already have changed state; no rollback or automatic retry is implied. Each invocation reports one terminal hook activity event. Late return values cannot replace prompts, arguments, results, or completion decisions, and unexpected late rejections are reported with secret redaction.

The context signal is scoped to the invocation and is aborted on timeout, turn cancellation, or invocation exit. Hooks must pass it to cancellable operations and await their work. These are waiting deadlines, not process isolation: Xal cannot preempt synchronous code that blocks its event loop or undo side effects from an uncooperative in-process plugin. Plugin bootstrap, shutdown, and prompt-section preparation are separate APIs and are not covered by these deadlines.

### Completion gates

`beforeComplete` runs when the agent is ready to finish, after the optional one-shot verification reminder (`verification.gate: true`) and before `turnEnd`. Required verification (`verification.gate: "required"`) instead checks evidence after `beforeComplete`, so hook-side workspace changes cannot retain a stale pass. It applies to primary and task-agent turns, including headless runs and schema-validated structured output. It does not run for direct user shell commands, session-restart control, failed turns, or interruptions. Existing `turnEnd` hooks remain completion observers and do not run on a blocked attempt. Required verification refreshes evidence once more after these observers: invalidated evidence fails the turn without rerunning them.

Return `undefined` to allow completion, or `{ type: "block", reason: "..." }` to send the model corrective feedback and continue the same turn. The reason must be non-empty after trimming and contain at most 4,000 Unicode characters. Invalid results and thrown errors fail the turn instead of allowing completion. Feedback passes through the normal secret redactor before entering conversation history. Permissions, cancellation, and repeated-tool-call guards still apply; blocking completion does not authorize any action.

The input contains `output` (text or a structured object), `usage` and `context` when available, and `continuationCount`, initially `0`. Hooks run in registration order; the first block stops that pass. Each hook receives an independent copy of the input. After a repair, the checks run again against the new proposed output. A rejected structured response must be submitted again. Input or background results arriving during an asynchronous check are processed before completion. Proposed responses may already have streamed to the user; they are not successful turn completion until the checks pass.

Xal permits three hook-driven continuations per turn. Another block fails the turn with the blocking hook's identity and reason; it never overrides the gate to report success. The counter is shared across hooks within that turn and resets on a new turn. Make checks repeatable and honor `ctx.signal`; put once-on-completion side effects in `turnEnd` instead. `/hooks` lists the `before_complete` event, and its decisions appear in the existing hook activity log.

For example, this plugin requires a non-empty `HANDOFF.md` before a primary agent finishes. It reads the actual file on each check rather than trusting the final answer's claim:

```ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export default {
  name: "handoff-gate",
  register(ctx) {
    ctx.registerHook({
      name: "require-handoff",
      async beforeComplete(input, ctx) {
        if (ctx.session.kind !== "primary" || ctx.session.mode === "plan") return
        let text
        try {
          text = await readFile(join(ctx.session.cwd, "HANDOFF.md"), { encoding: "utf8", signal: ctx.signal })
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
          return {
            type: "block",
            reason: "Create HANDOFF.md with the changes, verification results, and remaining work.",
          }
        }
        if (!text.trim()) return { type: "block", reason: "HANDOFF.md is empty. Add the handoff before finishing." }
      },
    })
  },
}
```

This checks the handoff's presence, not the truth of its contents. For test or build evidence tied to workspace state, use [configured verification checks](/docs/configs#verification-checks). Plugins run with host-process privileges: completion hooks do not make arbitrary plugin code sandboxed or permission-checked. Avoid running model-provided commands from a hook.

## Prompt preparation

A registered prompt section can implement `prepare(ctx, state, signal)` alongside its synchronous `text(ctx)` function. Preparation runs before model requests and manual compaction, receives the current session workspace, and can asynchronously load the data used by `text`. Handlers should be idempotent: preparation can run more than once before a request. An error or cancellation stops the request.

Returning a JSON object saves section state under its `id` in the existing session log. State is secret-redacted, unchanged values are not written again, and changed state is persisted before a provider request. The latest state survives compaction, fork, and resume; `/new` and workspace changes clear it. Returning `undefined` leaves saved state unchanged. Only one section with a given nonempty `id` can register a preparation handler. Plugins must validate restored state and check `ctx.cwd` before reusing workspace-dependent data; state is metadata, not additional conversation text.

The built-in project-instructions plugin uses this to save discovered instruction paths while keeping file contents workspace-scoped and reloading them on resume.

## Hook example

This plugin marks prompts and read results, and blocks an exact `git push` command:

```ts
export default {
  name: "visual-hooks",
  register(ctx) {
    ctx.registerHook({
      name: "marker",
      prompt(input) {
        return { type: "replace", text: `${input.text}\n\nInclude the exact marker HOOKS_ACTIVE in the answer.` }
      },
      beforeTool(input) {
        if (input.tool !== "bash" || input.args.command !== "git push") return
        return { type: "block", reason: "Publishing is disabled by the visual hook." }
      },
      afterTool(input) {
        if (input.tool !== "read") return
        return { type: "replace", output: `[visual-hooks]\n${input.output}` }
      },
    })
  },
}
```

Put the file at `plugin.ts` inside a plugin directory and add that directory's absolute path to `plugins`. In the TUI, `/hooks` lists every registered hook and the events it handles. Each completed primary-session hook invocation appears in the transcript with its action and elapsed time; task-agent hook invocations appear in that agent's job output.

## Plugin configuration

A custom plugin receives the object under `pluginConfig` whose key matches its exported plugin name:

```json
{
  "pluginConfig": {
    "example-plugin": {
      "enabled": true
    }
  }
}
```

Built-in plugin options are documented with their features in [TUI](/docs/tui), [Integrations](/docs/integrations), and [Providers and models](/docs/providers).

## Classification tool

The built-in `classify` plugin exposes the general-purpose [classification tool](/docs/configs#classification-tool). It uses `ctx.runtime.decisions`, independently of the `typesafe` provider plugin. It contributes a tool definition, not a system-prompt instruction or automatic planning/review workflow. The existing TypeSafe AI switch controls availability and inference. [Jev read-ahead](/docs/configs#jev-read-ahead) is part of the harness tool runner rather than a plugin: it reads the results of the registered `read`, `grep`, and `glob` tools by name and prefetches through whichever `read` tool is registered, so a plugin that replaces those tools keeps read-ahead working as long as the output still lists workspace paths.

## Programmatic tool dispatch

The built-in `code-mode` plugin uses the harness's guarded child-tool dispatcher rather than importing the file, search, or web plugins. See [Code Mode configuration](/docs/configs#code-mode) and [tool behavior](/docs/tools#code-mode).

A standard `Tool` with `orchestrates: true` receives `ctx.callTool(name, args, signal)` during agent execution. The harness supplies a deadline-bound `ctx.signal`, serializes approval preparation, limits concurrency and call/result budgets, and retains private child traces. The dispatcher accepts only the initial read-only allowlist; this flag does not grant arbitrary tool access. The harness always schedules orchestrating tools exclusively so they cannot race session interactions with another batch. The flag is not an isolation boundary for trusted plugin code: Code Mode separately uses QuickJS to isolate model-written JavaScript.

Child calls run the same lifecycle hooks as ordinary calls, but `afterTool` output is routed to the program instead of directly to model history. Hook implementations should not assume every invocation corresponds to its own model-facing tool result. The parent trace location is appended after its `afterTool` hooks, independently of the logical output used for repeat-loop detection. Child traces retain the effective arguments before permission approval and execution, including on cancellation, while the parent remains the only conversation-level call/result pair. Do not invoke another plugin's tool implementation directly to bypass this dispatcher.

## Text model catalogs

A text provider's `ModelCatalog.models` contains the models offered in the picker and model listings. Optional `lookupModels` preserve metadata for retired IDs used by saved selections without advertising them as choices. Both lists use the same `TextModelInfo` validation, and all model IDs and aliases must be unique across them. Lookup-only entries retain their own context windows, input modalities, thinking options, and configured compaction limits; they do not rewrite the selected API ID or guarantee continued upstream availability.

## Decision models

Providers and models have explicit kinds. `Provider` and `TextModelInfo` have `kind: "text"`; `DecisionProvider` and `DecisionModelInfo` have `kind: "decision"`. `AnyProvider` and `ModelInfo` are their respective unions. Existing text-provider plugins must add `kind: "text"` to their provider and model metadata. `ModelCatalog` defaults to text models; decision providers return `ModelCatalog<DecisionModelInfo>`.

Both provider kinds register through `ctx.registerProvider` and may implement `connect` to return a credential. A decision provider implements `listModels(profileId, refresh)` and `evaluate(profileId, request)` instead of `defaultModel` and `stream`. The harness accepts only text providers. Decision models are discovered separately and are never selectable as the harness model.

Consumers use `ctx.runtime.decisions`, so plugins never depend on or import one another. TypeSafe evaluations require the [Use TypeSafe AI](/docs/configs#typesafe-ai) setting to be On and the requested profile to match its selected profile. Connection/model discovery remains available while Off, but inference is blocked:

```ts
const connections = await ctx.runtime.decisions.connections()
const connection = connections.find((entry) => entry.provider.id === "typesafe")
if (!connection) throw new Error("Connect TypeSafe first")
const catalog = await ctx.runtime.decisions.models(connection.profile.id)
const model = catalog.models.find((entry) => entry.id === "jev-latest")
if (!model) throw new Error("Jev is unavailable")
const result = await ctx.runtime.decisions.evaluate(connection.profile.id, {
  model: model.id,
  state: { task: "Decide whether this old file read is still needed" },
  questions: {
    keep: { type: "noul", instructions: "Is this file content still needed for the current task?" },
  },
  signal: ctx.signal,
})
const keep = result.answers.keep
if (keep?.type !== "noul") throw new Error("Expected a Noul answer")
console.log({ retainOriginal: keep.noul >= 0.5 })
```

The service resolves the immutable profile and checks its provider kind on every operation. It exposes connection metadata but not credentials. Outbound state and question descriptions pass through Xal's secret redactor; model, question, or choice identifiers containing protected secrets are rejected rather than renamed. State is a string, JSON object, or array. Questions are a discriminated `DecisionQuestion` union: `noul`, `choice` (named criteria), or `score` (ordered levels). Instructions and rubric descriptions accept strings, objects, arrays, or null. `DecisionResponse` returns the resolved model ID, a map of discriminated answers under the original question IDs, and normalized token usage. Choice and Score include probability distributions and confidence. Consumers narrow `answer.type` and apply their own thresholds; probabilities do not guarantee correctness.

TypeSafe validates answer types, probabilities, choice membership, score ranges and legends, question coverage, and usage at the wire boundary. Failures reject the operation. A consumer must surface any fallback rather than silently ignoring errors. Abort signals propagate to the transport. Decision requests do not use the chat streaming contract.
