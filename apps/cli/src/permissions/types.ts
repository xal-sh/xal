import type { JsonObject } from "../lib/json"

export type PermissionMode = string

export type PermissionScope = "once" | "session" | "always"

export type PolicyDecision = "allow" | "deny" | "ask" | "classify"

export interface PermissionRequest {
  sessionKey: object
  cwd: string
  tool: string
  title: string
  args: JsonObject
  subject: string | undefined
  readOnly: boolean
  sandboxed: boolean
  mode: PermissionMode
  inheritedDenyMode?: PermissionMode
}

export interface PolicyRule {
  evaluate(request: PermissionRequest): PolicyDecision | undefined
}

export interface PermissionRules {
  allow?: string[]
  ask?: string[]
  deny?: string[]
}

export interface ModeDefinition {
  name: string
  readOnly: boolean
  skipAsk: boolean
  classifyUnresolved: boolean
  guidance: string
  subagentGuidance: string
}
