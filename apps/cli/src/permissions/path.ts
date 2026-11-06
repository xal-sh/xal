import { readlinkSync, realpathSync } from "node:fs"
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isMissingPathError } from "../lib/error"
import { asString, isRecord } from "../lib/json"
import { displayPath, resolveFilePath } from "../lib/path"
import type { ToolPermission } from "../tools/types"

function canonicalPath(path: string, links = 0): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    const resolved = join(canonicalPath(parent, links), basename(path))
    let target: string
    try {
      target = readlinkSync(resolved)
    } catch (error) {
      if (isMissingPathError(error) || (isRecord(error) && asString(error.code) === "EINVAL")) return resolved
      throw error
    }
    if (links >= 40) throw new Error(`Too many symbolic links: ${path}`, { cause: error })
    return canonicalPath(resolve(dirname(resolved), target), links + 1)
  }
}

export function pathPermission(tool: string, path: string, cwd: string): ToolPermission {
  if (!path) return { subject: "" }
  const root = canonicalPath(cwd)
  const absolute = canonicalPath(resolveFilePath(path, cwd))
  const rel = relative(root, absolute)
  const outsideWorkspace = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  const subject = displayPath(absolute, root)
  const dir = dirname(subject)
  const pattern = dir === "." || dir === subject ? subject : `${dir}/*`
  const original = displayPath(path, cwd)
  return {
    subject,
    ...(original === subject ? {} : { subjectAliases: [original] }),
    suggestion: `${tool}(${pattern})`,
    outsideWorkspace,
  }
}
