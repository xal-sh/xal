import { appInfo } from "../../app-info"
import { listCommands } from "../../commands/registry"
import { asString } from "../../lib/json"
import { modeDefinition } from "../../permissions/modes"
import { contributeRules } from "../../permissions/rules"
import { getTool, listTools, registerTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { LivePlugins, PluginScope } from "./manager"

function scopeOf(value: unknown): PluginScope {
  if (value === "user" || value === "project") return value
  throw new Error("scope must be project or user")
}

export function registerLivePluginTools(plugins: LivePlugins): string[] {
  const notices: string[] = []
  const add = (tool: Tool) => {
    if (getTool(tool.name)) {
      notices.push(`Live plugin management tool ${tool.name} is unavailable: the name is already registered`)
      return
    }
    registerTool(tool)
    if (tool.name === "activate_plugin") contributeRules({ ask: [tool.name] })
  }
  const name = { type: "string", description: "Lower-case plugin directory and export name" }
  const scope = {
    type: "string",
    enum: ["project", "user"],
    description: "Launch project or all projects for this user",
  }
  add({
    name: "xal_info",
    description:
      "Inspect this Xal version, registered plugins, tools, commands and live plugin draft directories. Pass a name and scope to fingerprint that single plugin.ts without executing it. Use the xal-help skill for bundled documentation.",
    parameters: { type: "object", properties: { name, scope }, additionalProperties: false },
    title: (args) => asString(args.name) ?? "Xal runtime",
    readOnly: () => true,
    concurrency: () => "shared",
    async execute(args, ctx) {
      if (args.name != null || args.scope != null) {
        const draft = await plugins.inspect(scopeOf(args.scope), asString(args.name) ?? "", ctx.cwd)
        return { output: JSON.stringify(draft, null, 2) }
      }
      return {
        output: JSON.stringify(
          {
            app: appInfo.name,
            version: appInfo.version,
            launchProject: plugins.root,
            pluginDirectories: plugins.directories,
            startupPlugins: plugins.startupPlugins(),
            livePlugins: plugins.list(),
            registeredTools: listTools().map((tool) => tool.name),
            commands: listCommands()
              .filter((command) => !command.hidden)
              .map((command) => command.name),
          },
          null,
          2,
        ),
      }
    },
  } satisfies Tool)
  add({
    name: "activate_plugin",
    description:
      "Load or replace an inspected single-file Xal plugin now and on future launches in the selected scope. Executes trusted code with full host privileges, not in a sandbox. Requires the exact draft sha256 from xal_info. Supports tools, slash commands and tool-result renderers; registration failures keep the last working version.",
    parameters: {
      type: "object",
      properties: { name, scope, sha256: { type: "string", description: "Exact SHA-256 from draft inspection" } },
      required: ["name", "scope", "sha256"],
      additionalProperties: false,
    },
    title: (args) =>
      `Run and persist ${asString(args.scope)} plugin ${asString(args.name)} with host privileges (${asString(args.sha256)?.slice(0, 12)})`,
    available: (ctx) => ctx.kind === "primary" && !modeDefinition(ctx.mode).readOnly,
    permission: (args) => ({ subject: `${asString(args.scope)}:${asString(args.name)}:${asString(args.sha256)}` }),
    async execute(args, ctx) {
      const scope = scopeOf(args.scope)
      const name = asString(args.name) ?? ""
      await plugins.activate(scope, name, asString(args.sha256) ?? "", ctx.cwd, ctx.signal)
      return {
        output: `Active now: ${scope} plugin ${name}. It will reload on startup. Delete its plugin folder to uninstall.`,
      }
    },
  } satisfies Tool)
  return notices
}
