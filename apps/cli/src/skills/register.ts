import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { registerPrompt } from "../agent/prompt/registry"
import { agentHome, projectConfigPath } from "../config/paths"
import { findProjectRoot } from "../project/root"
import { registerTool } from "../tools/registry"
import { loadSkills } from "./catalog"
import { listSkills, replaceSkills } from "./registry"
import { skillTool } from "./tool"

export function compactSkillDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim()
  if (normalized.length <= 160) return normalized
  const boundary = normalized.lastIndexOf(" ", 159)
  return `${normalized.slice(0, boundary > 80 ? boundary : 159).trimEnd()}…`
}

function catalogPrompt(): string {
  const skills = listSkills()
  if (skills.length === 0) return ""
  const entries = skills.map((skill) => `- ${skill.name}: ${compactSkillDescription(skill.description)}`)
  return [
    "Available skills follow. Load one when its description matches, or when the user explicitly invokes $name. Full instructions load on demand with the skill tool.",
    ...entries,
  ].join("\n")
}

export function registerSkills(): void {
  replaceSkills([])
  registerTool(skillTool)
  registerPrompt({ id: "skills", text: catalogPrompt })
}

export async function discoverSkills(): Promise<string[]> {
  const root = await findProjectRoot(process.cwd())
  const loaded = await loadSkills([
    { directory: join(homedir(), ".agents", "skills"), source: "user" },
    { directory: join(agentHome(), "skills"), source: "user" },
    { directory: join(root, ".agents", "skills"), source: "project" },
    { directory: join(dirname(projectConfigPath(root)), "skills"), source: "project" },
  ])
  replaceSkills(loaded.skills)
  return loaded.failures.map((failure) => `${failure.path}: ${failure.reason}`)
}
