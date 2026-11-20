import { appInfo } from "../app-info"
import { embedDocs } from "./embed-docs" with { type: "macro" }
import type { Skill } from "./types"

const docs = new Map(Object.entries(embedDocs()))

export const builtinSkills: Skill[] = [
  {
    source: "builtin",
    name: "xal-help",
    description:
      "Answer questions about Xal itself: its configuration, tools, UI, permissions, skills, integrations, and plugins.",
    body: `These are the offline docs for ${appInfo.displayName} ${appInfo.version}. Read the relevant supporting file with the skill tool. For what is actually registered in this process, use xal_info rather than assuming all documented capabilities are enabled.`,
    resources: docs,
  },
  {
    source: "builtin",
    name: "xal-plugin",
    description:
      "Create, update, and hot-load Xal plugins, including tools, slash commands, and custom tool-result UI, for one project or for the user.",
    body: [
      "Use xal_info to find the running version, registered names, and plugin directories. Default to project scope; use user scope for a plugin requested across projects.",
      "Read the Live plugins section of plugins.md with the skill tool for the API and a working example. Write a single <name>/plugin.ts under the chosen draft directory. Do not edit Xal source, config, or the approval store.",
      "Inspect the draft with xal_info(name, scope), then call activate_plugin with that exact scope, name, and sha256. Explain that this runs trusted host code. Do not work around a denial. Verify the new tool in the same session, or tell the user the slash command to try. For an update, edit the draft and repeat inspection and activation. To uninstall, remove that plugin’s folder, not just plugin.ts; Xal forgets the approval on the next idle check or startup.",
    ].join("\n\n"),
    resources: new Map([["plugins.md", docs.get("plugins.md")!]]),
  },
]
