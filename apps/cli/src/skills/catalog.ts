import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { describeError, isMissingPathError } from "../lib/error"
import { asString, isRecord } from "../lib/json"
import type { Skill, SkillSource } from "./types"

const MAX_SKILL_BYTES = 64 * 1024
const MAX_RESOURCE_BYTES = 50_000

export interface SkillRoot {
  directory: string
  source: SkillSource
}

export interface SkillLoadFailure {
  path: string
  reason: string
}

export interface SkillLoadResult {
  skills: Skill[]
  failures: SkillLoadFailure[]
}

interface SkillDocument {
  name: string
  description: string
  body: string
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
}

async function existingStats(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

async function walkFiles(directory: string, visited = new Set<string>()): Promise<string[]> {
  let canonical: string
  try {
    canonical = await realpath(directory)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
  if (visited.has(canonical)) return []
  visited.add(canonical)

  const found: string[] = []
  const children = (await entries(canonical)).sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const path = resolve(directory, child.name)
    const info = child.isSymbolicLink() ? await existingStats(path) : undefined
    if (child.isDirectory() || info?.isDirectory()) {
      found.push(...(await walkFiles(path, visited)))
      continue
    }
    if (child.isFile() || info?.isFile()) found.push(path)
  }
  return found
}

async function findSkillFiles(directory: string): Promise<string[]> {
  return (await walkFiles(directory)).filter((path) => basename(path) === "SKILL.md")
}

function parseSkill(path: string, content: string): SkillDocument {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!frontmatter) throw new Error(`${path}: SKILL.md must begin with closed YAML frontmatter`)

  let fields: unknown
  try {
    fields = Bun.YAML.parse(frontmatter[1] ?? "")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${path}: invalid YAML frontmatter: ${reason}`, { cause: error })
  }
  if (!isRecord(fields)) throw new Error(`${path}: frontmatter must be an object`)

  const name = asString(fields.name)?.trim()
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${path}: name must use 1-64 lower-case letters, numbers, and single hyphens`)
  }
  if (basename(dirname(path)) !== name) {
    throw new Error(`${path}: parent directory must be named ${name}`)
  }

  const description = asString(fields.description)?.trim()
  if (!description || description.length > 1024) {
    throw new Error(`${path}: description must contain 1-1024 characters`)
  }

  const body = normalized.slice(frontmatter[0].length).trim()
  if (!body) throw new Error(`${path}: skill instructions must not be empty`)
  return { name, description, body }
}

async function loadSkill(path: string, source: SkillSource): Promise<Skill> {
  const info = await stat(path)
  if (info.size > MAX_SKILL_BYTES) throw new Error(`${path}: SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`)
  const document = parseSkill(path, await readFile(path, "utf8"))
  return { ...document, directory: resolve(path, ".."), path, source }
}

async function loadRoot(root: SkillRoot): Promise<SkillLoadResult> {
  const paths = await findSkillFiles(root.directory)
  const outcomes = await Promise.allSettled(paths.map((path) => loadSkill(path, root.source)))
  const skills: Skill[] = []
  const failures: SkillLoadFailure[] = []
  const names = new Set<string>()

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      const path = paths[index]!
      const reason = describeError(outcome.reason)
      failures.push({ path, reason: reason.startsWith(`${path}: `) ? reason.slice(path.length + 2) : reason })
      continue
    }
    if (names.has(outcome.value.name)) {
      throw new Error(`${root.directory}: duplicate skill name: ${outcome.value.name}`)
    }
    names.add(outcome.value.name)
    skills.push(outcome.value)
  }
  return { skills, failures }
}

export async function loadSkills(roots: SkillRoot[]): Promise<SkillLoadResult> {
  const catalog = new Map<string, Skill>()
  const failures: SkillLoadFailure[] = []
  for (const root of roots) {
    const loaded = await loadRoot(root)
    failures.push(...loaded.failures)
    for (const skill of loaded.skills) catalog.set(skill.name, skill)
  }
  const skills = [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name))
  return { skills, failures }
}

export async function listSkillFiles(skill: Skill): Promise<string[]> {
  const root = await realpath(skill.directory)
  const files: string[] = []
  for (const path of await walkFiles(skill.directory)) {
    if (path === skill.path) continue
    const canonical = await realpath(path)
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) continue
    files.push(relative(skill.directory, path))
  }
  return files
}

export async function readSkillResource(skill: Skill, resource: string): Promise<string> {
  if (!resource || isAbsolute(resource)) throw new Error("path must be relative to the skill directory")
  const root = await realpath(skill.directory)
  const candidate = resolve(root, resource)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("path must stay inside the skill directory")
  }
  const path = await realpath(candidate).catch((error: unknown) => {
    if (isMissingPathError(error)) throw new Error(`skill file not found: ${resource}`, { cause: error })
    throw error
  })
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error("path must stay inside the skill directory")
  }
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`skill path is not a file: ${resource}`)
  if (info.size > MAX_RESOURCE_BYTES) throw new Error(`skill file exceeds ${MAX_RESOURCE_BYTES} bytes: ${resource}`)
  const content = await readFile(path, "utf8")
  if (content.includes("\u0000")) throw new Error(`skill file is binary: ${resource}`)
  return content
}
