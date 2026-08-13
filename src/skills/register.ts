import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { registerPrompt } from "../agent/prompt"
import { agentHome, projectConfigPath } from "../config/paths"
import { findProjectRoot } from "../project/root"
import { registerTool } from "../tools/registry"
import { loadSkills } from "./catalog"
import { listSkills, replaceSkills } from "./registry"
import { skillTool } from "./tool"

function catalogPrompt(): string {
  const skills = listSkills()
  if (skills.length === 0) return ""
  const entries = skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`)
  return [
    "Reusable skills are available. Their metadata is listed below; full instructions stay out of context until loaded with the skill tool or injected by an explicit $name invocation.",
    ...entries,
  ].join("\n")
}

export function registerSkills(): void {
  replaceSkills([])
  registerTool(skillTool)
  registerPrompt({ id: "skills", text: catalogPrompt })
}

export async function discoverSkills(): Promise<void> {
  const root = await findProjectRoot(process.cwd())
  replaceSkills(
    await loadSkills([
      { directory: join(homedir(), ".agents", "skills"), source: "user" },
      { directory: join(agentHome(), "skills"), source: "user" },
      { directory: join(root, ".agents", "skills"), source: "project" },
      { directory: join(dirname(projectConfigPath(root)), "skills"), source: "project" },
    ]),
  )
}
