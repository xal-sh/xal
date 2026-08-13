import { asString } from "../lib/json"
import { getSkill } from "./registry"
import type { Skill } from "./types"
import type { Tool } from "../tools/types"
import { listSkillFiles, readSkillResource } from "./catalog"

function requiredSkill(args: Record<string, unknown>): Skill {
  const name = asString(args.name)?.trim()
  if (!name) throw new Error("name is required")
  const skill = getSkill(name)
  if (!skill) throw new Error(`unknown skill: ${name}`)
  return skill
}

export async function renderSkill(skill: Skill): Promise<string> {
  const files = await listSkillFiles(skill)
  const resources =
    files.length === 0 ? "Supporting files: none" : `Supporting files:\n${files.map((path) => `- ${path}`).join("\n")}`
  return [`Skill: ${skill.name}`, `Directory: ${skill.directory}`, resources, skill.body].join("\n\n")
}

export const skillTool: Tool = {
  name: "skill",
  description:
    "Load a discovered skill's instructions and supporting-file list into the conversation, or read one supporting text file from its package. Call without path before using a skill.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name from the available-skills catalog",
      },
      path: {
        type: "string",
        description: "Supporting file path relative to the skill directory. Omit to load the skill's instructions",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  prompt:
    "Use skill when a task implicitly matches one from the catalog, then follow its instructions over your defaults and read only the supporting files it requires. A skill selected with an explicit $name invocation is already present in that user message; do not load it again. Use path to read a listed supporting file when the loaded instructions require it.",
  title(args) {
    const name = asString(args.name) ?? ""
    const path = asString(args.path)
    return path ? `${name}/${path}` : name
  },
  readOnly() {
    return true
  },
  concurrency() {
    return "shared"
  },
  async execute(args) {
    const skill = requiredSkill(args)
    const path = asString(args.path)
    if (path !== undefined) return { output: await readSkillResource(skill, path) }
    return { output: await renderSkill(skill) }
  },
}
