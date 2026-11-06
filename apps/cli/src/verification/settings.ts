import { isRecord } from "../lib/json"

export interface VerificationSettings {
  checks: Record<string, string>
  gate: boolean
}

export function parseVerificationSettings(value: unknown): VerificationSettings {
  if (value === undefined) return { checks: {}, gate: false }
  if (!isRecord(value)) throw new Error("verification must be an object")
  const unknown = Object.keys(value).find((key) => key !== "checks" && key !== "gate")
  if (unknown !== undefined) throw new Error(`verification.${unknown} is not supported`)
  if (value.gate !== undefined && typeof value.gate !== "boolean")
    throw new Error("verification.gate must be a boolean")
  const gate = value.gate === true
  if (value.checks === undefined) return { checks: {}, gate }
  if (!isRecord(value.checks)) throw new Error("verification.checks must be an object")
  const checks: Record<string, string> = {}
  const commands = new Set<string>()
  for (const [name, command] of Object.entries(value.checks)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new Error(
        "verification check names must start with a lower-case letter and contain letters, digits, - or _",
      )
    }
    if (typeof command !== "string" || !command.trim()) {
      throw new Error(`verification.checks.${name} must be a non-empty command`)
    }
    if (commands.has(command.trim())) throw new Error("verification checks must have distinct commands")
    checks[name] = command.trim()
    commands.add(command.trim())
  }
  return { checks, gate }
}
