import { modeDefinition } from "./modes"
import { isDenied, loadRememberedRules, matchRules } from "./rules"
import type { ModeDefinition, PermissionRequest, PolicyDecision, PolicyRule } from "./types"

const rules: PolicyRule[] = []

export function registerPolicyRule(rule: PolicyRule): void {
  rules.push(rule)
}

function evaluateRegistered(request: PermissionRequest): PolicyDecision | undefined {
  const decisions = rules.flatMap((rule) => {
    const decision = rule.evaluate(request)
    return decision ? [decision] : []
  })
  if (decisions.includes("deny")) return "deny"
  if (decisions.includes("ask")) return "ask"
  if (decisions.includes("classify")) return "classify"
  return decisions.includes("allow") ? "allow" : undefined
}

function underMode(decision: PolicyDecision, mode: ModeDefinition): PolicyDecision {
  if (mode.skipAsk && (decision === "ask" || decision === "classify")) return "allow"
  if (mode.readOnly && decision === "classify") return "ask"
  return decision
}

export async function evaluatePolicy(request: PermissionRequest): Promise<PolicyDecision> {
  await loadRememberedRules(request.cwd)

  const mode = modeDefinition(request.mode)
  if (isDenied(request)) return "deny"
  if (mode.readOnly && !request.readOnly) return "deny"

  const registered = evaluateRegistered(request)
  if (registered === "deny") return "deny"

  const matched = matchRules(request)
  if (matched === "ask") return underMode("ask", mode)
  if (registered === "ask") return underMode("ask", mode)
  if (matched === "allow") return "allow"
  if (registered) return underMode(registered, mode)

  if (request.readOnly || request.sandboxed) return "allow"
  return mode.classifyUnresolved ? "classify" : "allow"
}
