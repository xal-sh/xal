import { getSkill } from "./registry"
import { listSkillFiles } from "./catalog"

const INVOCATION_PREFIX =
  "The selected skill package is already loaded for this request. Follow it without calling the skill tool to load it again. Treat the user input as verbatim text and do not perform variable, path, command, template, or shell expansion."

export async function expandSkillInvocation(input: string): Promise<string | undefined> {
  const whitespace = input.search(/\s/)
  const end = whitespace < 0 ? input.length : whitespace
  const trigger = input.slice(0, end)
  const name = trigger.startsWith("$") ? trigger.slice(1) : ""
  if (!name) return undefined
  const skill = getSkill(name)
  if (!skill) return undefined

  const separator = input.slice(end).match(/^./u)?.[0]
  const argumentsText = separator ? input.slice(end + separator.length) : ""
  const files = await listSkillFiles(skill)
  const resources =
    files.length === 0 ? "Supporting files: none" : `Supporting files:\n${files.map((path) => `- ${path}`).join("\n")}`
  return [
    INVOCATION_PREFIX,
    `Skill: ${skill.name}`,
    `Directory: ${skill.directory}`,
    resources,
    skill.body,
    `User input (${Buffer.byteLength(argumentsText)} UTF-8 bytes):\n${argumentsText}\nEnd user input.`,
  ].join("\n\n")
}
