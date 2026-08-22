import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { redactText } from "../secrets/redactor"

export function agentHome(): string {
  return process.env[appEnvVar("HOME")]?.trim() || join(homedir(), `.${appInfo.name}`)
}

export function userConfigPath(): string {
  return join(agentHome(), "config.json")
}

export function projectConfigPath(root: string): string {
  return join(root, `.${appInfo.name}`, "config.json")
}

export function projectMcpConfigPath(root: string): string {
  return join(root, ".mcp.json")
}

export function credentialsPath(): string {
  return join(agentHome(), "credentials.json")
}

export function cacheDir(): string {
  return join(agentHome(), "cache")
}

export function sessionsDir(): string {
  return join(agentHome(), "sessions")
}

export function globalMemoryPath(): string {
  return join(agentHome(), "MEMORY.md")
}

export function worktreesDir(): string {
  return join(agentHome(), "worktrees")
}

export function backgroundSessionsDir(): string {
  return join(agentHome(), "bg")
}

export function backgroundSessionDir(sessionId: string): string {
  if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId)) {
    throw new Error(`invalid background session id: ${sessionId}`)
  }
  return join(backgroundSessionsDir(), sessionId)
}

export function profilerDir(): string {
  return join(agentHome(), "profiler")
}

export function usageDir(): string {
  return join(agentHome(), "usage")
}

function projectSlug(cwd: string): string {
  const redacted = redactText(cwd)
  const slug = redacted.replace(/[^a-zA-Z0-9]+/g, "-")
  if (redacted === cwd) return slug
  return `${slug}-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`
}

export function projectSessionsDir(cwd: string): string {
  return join(sessionsDir(), projectSlug(cwd))
}

export function projectMessageHistoryPath(root: string): string {
  return join(agentHome(), "history", `${createHash("sha256").update(root).digest("hex")}.jsonl`)
}
