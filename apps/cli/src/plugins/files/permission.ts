import { lstatSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { asString, isRecord } from "../../lib/json"
import { displayPath, resolveFilePath } from "../../lib/path"
import type { PermissionRequest, PolicyDecision } from "../../permissions/types"
import type { ToolPermission } from "../../tools/types"

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function missingPath(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

export function canonicalTarget(path: string): string | undefined {
  let current = path
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(current), ...suffix)
    } catch (error) {
      if (!missingPath(error)) return undefined
      try {
        if (lstatSync(current).isSymbolicLink()) return undefined
      } catch (statError) {
        if (!missingPath(statError)) return undefined
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

function sensitiveRead(path: string): boolean {
  const name = basename(path)
  if (name === ".env" || name.startsWith(".env.")) return true
  return [".ssh", ".aws", ".gnupg"].some((directory) => inside(path, resolve(homedir(), directory)))
}

export function filePolicy(request: PermissionRequest): PolicyDecision | undefined {
  if (request.tool !== "read" && request.tool !== "write" && request.tool !== "edit") return undefined
  const path = canonicalTarget(resolveFilePath(asString(request.args.file_path) ?? "", request.cwd))
  if (!path) return "classify"
  if (request.tool === "read") return sensitiveRead(path) ? "classify" : undefined
  const workspace = canonicalTarget(request.cwd) ?? resolve(request.cwd)
  const temporary = canonicalTarget(tmpdir()) ?? resolve(tmpdir())
  const legacyTemporary = canonicalTarget("/tmp") ?? resolve("/tmp")
  if (inside(path, workspace) || inside(path, temporary) || inside(path, legacyTemporary)) return "allow"
  return "classify"
}

export function pathPermission(tool: string, args: Record<string, unknown>, cwd: string): ToolPermission {
  const logical = resolveFilePath(asString(args.file_path) ?? "", cwd)
  const target = canonicalTarget(logical)
  const subject = target
    ? displayPath(target, canonicalTarget(cwd) ?? resolve(cwd))
    : `[unresolved path boundary] ${displayPath(logical, cwd)}`
  const dir = dirname(subject)
  if (!subject || dir === "." || dir === subject) return { subject, suggestion: `${tool}(${subject})` }
  return { subject, suggestion: `${tool}(${dir}/*)` }
}
