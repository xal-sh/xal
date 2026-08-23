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

Xal keeps its built-in system prompt small: identity, current environment, permission state, and stateful workflows that the user explicitly entered, such as plan mode. Tool definitions reach the model through the provider's native tool schema. A tool description should explain capability, inputs, effects, limits, and failure conditions; it should not tell the model to prefer that tool or impose a general workflow.

Plugins may contribute system-prompt sections with `ctx.registerPrompt`. Reserve these for runtime state, an explicitly enabled mode, or instructions intrinsic to the plugin as a whole. Project `AGENTS.md` files, the skill catalog, configured MCP server instructions, and global memory are intentional prompt contributions because the user enabled those context sources. Prompt hooks can replace individual user messages and therefore remain a separate, explicitly trusted extension point.

## Lifecycle

`ctx.runtime` exposes the app name and version, app home and cache paths, profile-aware credential loading, saving, and compare-and-swap replacement, plus transient secret protection. Credential operations require both the provider ID and immutable profile ID. Provider plugins should use this runtime instead of reading or rewriting Xal's shared credential file directly. Provider model discovery and streaming also receive the profile ID, while `connect` returns a credential for the core to store under the user-provided profile name.

Plugins can contribute slash commands with `ctx.registerCommand`. Commands known synchronously belong in `register`; commands discovered from files or services may be added during `bootstrap`, before interactive input is released.

When the UI or CLI exits, Xal aborts `ctx.signal` so in-progress bootstrap work can stop, waits for bootstrap to settle, and then runs `shutdown` in reverse plugin order. Plugins that own child processes or network connections close them there. A dynamically discovered tool can be removed with `ctx.unregisterTool(tool)` using the same tool object that was registered. Tools that retain resources for an agent session can register per-session cleanup with `ctx.registerToolSessionDisposer`.

## Hooks

Plugins register trusted lifecycle hooks with `ctx.registerHook`. Hooks run in built-in and configured-plugin order. Multiple hooks for the same event run sequentially, and a replacement from one hook becomes the input to the next.

| Handler      | Input                                       | Allowed result                                              |
| ------------ | ------------------------------------------- | ----------------------------------------------------------- |
| `prompt`     | Model-facing prompt text and image count    | Replace the text or reject the prompt                       |
| `beforeTool` | Tool name, call ID, and JSON arguments      | Replace the arguments or block the call                     |
| `afterTool`  | Tool details and its model-facing output    | Replace the output                                          |
| `turnEnd`    | Final output and token usage when available | No result; use it for lifecycle automation or observability |

Every handler also receives a context containing an abort signal and the session ID, kind, working directory, provider, model, and permission mode. Prompt changes affect what the model sees while the TUI keeps the user's original text. Tool argument changes happen before scheduling and permission evaluation, so Xal authorizes and records the effective action. Post-tool hooks also run for failed or interrupted executions, but not for calls blocked before execution.

Hook failures stop prompt, pre-tool, and turn-completion processing. A post-tool failure becomes a failed tool result that warns the model the tool may already have changed state. Hook inputs and code run inside Xal's process, so only load hooks you trust. Returned text and arguments pass through secret redaction before they reach the model, session storage, or TUI.

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
