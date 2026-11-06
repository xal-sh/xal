import { readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { isMissingPathError } from "../../lib/error"
import { findProjectRoot } from "../../project/root"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface ProjectInstructionSource {
  path: string
  content: string
  truncated: boolean
}

export interface ProjectInstructions {
  root: string
  sources: ProjectInstructionSource[]
  skipped: string[]
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

export function directoriesToRoot(root: string, cwd: string): string[] {
  const directories: string[] = []
  let directory = cwd
  while (true) {
    directories.push(directory)
    if (directory === root) return directories
    directory = dirname(directory)
  }
}

function utf8Prefix(content: string, maxBytes: number): string {
  const bytes = encoder.encode(content)
  if (bytes.length <= maxBytes) return content
  let end = maxBytes
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

export async function loadProjectInstructions(cwd: string, maxBytes: number): Promise<ProjectInstructions> {
  const resolvedCwd = resolve(cwd)
  const root = await findProjectRoot(resolvedCwd)
  const sources: ProjectInstructionSource[] = []
  const skipped: string[] = []
  let remaining = maxBytes

  for (const directory of directoriesToRoot(root, resolvedCwd)) {
    const path = join(directory, "AGENTS.md")
    const content = await readOptional(path)
    if (content === undefined || content.trim().length === 0) continue

    const bytes = encoder.encode(content)
    if (bytes.length <= remaining) {
      sources.push({ path, content, truncated: false })
      remaining -= bytes.length
      continue
    }

    const prefix = utf8Prefix(content, remaining)
    remaining = 0
    if (prefix.length === 0) {
      skipped.push(path)
      continue
    }
    sources.push({ path, content: prefix, truncated: true })
  }

  return { root, sources: sources.reverse(), skipped: skipped.reverse() }
}

export function renderNestedInstructions(root: string, sources: Map<string, string>, maxBytes: number): string {
  if (sources.size === 0) return ""
  let remaining = maxBytes
  const sections: string[] = []
  const omitted: string[] = []
  for (const [path, content] of sources) {
    const name = relative(root, path)
    const prefix = utf8Prefix(content, remaining)
    remaining -= encoder.encode(prefix).length
    if (prefix.length === 0) {
      omitted.push(name)
      continue
    }
    const notice = prefix === content ? "" : "\n\n[This instruction file was truncated at the configured byte budget.]"
    sections.push(`## ${name}\n\n${prefix}${notice}`)
  }
  return [
    "Nested project instructions follow for directories this session has worked in. Each applies to files under its own directory and takes precedence over instructions from parent directories.",
    ...sections,
    ...(omitted.length === 0 ? [] : [`[Omitted at the configured byte budget: ${omitted.join(", ")}.]`]),
  ].join("\n\n")
}

export function renderProjectInstructions(instructions: ProjectInstructions): string {
  if (instructions.sources.length === 0) return ""
  const sections = instructions.sources.map((source) => {
    const path = relative(instructions.root, source.path) || "AGENTS.md"
    const notice = source.truncated ? "\n\n[This instruction file was truncated at the configured byte budget.]" : ""
    return `## ${path}\n\n${source.content}${notice}`
  })
  const skipped = instructions.skipped.map((path) => relative(instructions.root, path))
  const omission = skipped.length === 0 ? [] : [`[Omitted at the configured byte budget: ${skipped.join(", ")}.]`]
  return [
    "Project instructions follow. Instructions from files nearer the working directory take precedence when they conflict with earlier files.",
    ...sections,
    ...omission,
  ].join("\n\n")
}
