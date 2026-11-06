import { modeDefinition } from "./modes"
import { isDenied, loadRememberedRules, matchRules } from "./rules"
import type { ModeDefinition, PermissionRequest, PolicyDecision, PolicyRule } from "./types"

const rules: PolicyRule[] = []

export function registerPolicyRule(rule: PolicyRule): void {
  rules.push(rule)
}

function evaluateRegistered(request: PermissionRequest): PolicyDecision | undefined {
  for (let index = rules.length - 1; index >= 0; index--) {
    const decision = rules[index]!.evaluate(request)
    if (decision) return decision
  }
  return undefined
}

function underMode(decision: PolicyDecision, mode: ModeDefinition): PolicyDecision {
  return mode.skipAsk && decision === "ask" ? "allow" : decision
}

export async function evaluatePolicy(request: PermissionRequest): Promise<PolicyDecision> {
  await loadRememberedRules(request.cwd)

  const mode = modeDefinition(request.mode)
  if (isDenied(request)) return "deny"
  if (mode.readOnly && !request.readOnly) return "deny"

  const registered = evaluateRegistered(request)
  if (registered === "deny") return "deny"
  if (request.outsideWorkspace) return underMode(matchRules(request, false) ?? "ask", mode)
  if (registered) return underMode(registered, mode)

  const matched = matchRules(request)
  if (matched) return underMode(matched, mode)

  return "allow"
}
