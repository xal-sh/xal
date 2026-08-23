import { isDenied, matchRules } from "../../permissions/rules"
import type { PermissionRequest, PolicyDecision } from "../../permissions/types"
import { commandEscapesWorkspace, commandSubjects } from "./risk"
import { commandSegments } from "./split"

const RISKY_COMMANDS = [
  "sudo *",
  "doas *",
  "dd *",
  "mkfs*",
  "shutdown*",
  "reboot*",
  "curl *",
  "wget *",
  "git push --force*",
  "git push * --force*",
  "git push -f*",
  "git push * -f*",
  "git push +*",
  "git push * +*",
  "npm publish*",
  "pnpm publish*",
  "yarn publish*",
  "bun publish*",
  "cargo publish*",
]

export function commandRiskRules(tool: string): string[] {
  return RISKY_COMMANDS.map((pattern) => `${tool}(${pattern})`)
}

export function commandPolicy(request: PermissionRequest, command: string): PolicyDecision | undefined {
  const segments = commandSegments(command)
  if (!segments) return "ask"
  const decisions = segments.map((segment) => commandSegmentPolicy(request, segment))
  if (decisions.includes("deny")) return "deny"
  if (decisions.includes("ask")) return "ask"
  return decisions.every((decision) => decision === "allow") ? "allow" : undefined
}

export function commandSegmentPolicy(request: PermissionRequest, segment: string): PolicyDecision | undefined {
  const scoped = { ...request, subject: segment }
  if (isDenied(scoped)) return "deny"
  const matched = matchRules(scoped)
  if (matched) return matched
  let normalizedAllowed = false
  for (const normalized of commandSubjects(segment)) {
    if (normalized === segment) continue
    const normalizedRequest = { ...request, subject: normalized }
    if (isDenied(normalizedRequest)) return "deny"
    const normalizedMatch = matchRules(normalizedRequest)
    if (normalizedMatch === "ask") return "ask"
    if (normalizedMatch === "allow") normalizedAllowed = true
  }
  if (commandEscapesWorkspace(segment, request.cwd)) return "ask"
  return normalizedAllowed ? "allow" : undefined
}
