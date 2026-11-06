export type PermissionMode = string

export type PermissionScope = "once" | "session" | "always"

export type PolicyDecision = "allow" | "deny" | "ask"

export interface PermissionRequest {
  sessionKey: object
  cwd: string
  tool: string
  title: string
  args: Record<string, unknown>
  subject: string | undefined
  subjectAliases?: string[]
  readOnly: boolean
  sandboxed: boolean
  outsideWorkspace?: boolean
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
  guidance: string
  subagentGuidance: string
}
