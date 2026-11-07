import type { SessionKind } from "../agent/types"
import type { JsonObject } from "../lib/json"
import type { PermissionMode } from "../permissions/types"
import type { Usage } from "../providers/types"

export type HookEvent = "prompt" | "before_tool" | "after_tool" | "before_complete" | "turn_end"

export type HookAction = "continued" | "modified" | "blocked" | "failed" | "interrupted"

export interface HookSession {
  id: string
  kind: SessionKind
  cwd: string
  provider: string
  profile: string
  model: string
  mode: PermissionMode
}

export interface HookContext {
  session: HookSession
  signal: AbortSignal
}

export interface PromptHookInput {
  text: string
  imageCount: number
}

export type PromptHookResult = { type: "replace"; text: string } | { type: "reject"; reason: string } | undefined

export interface BeforeToolHookInput {
  callId: string
  tool: string
  args: JsonObject
}

export type BeforeToolHookResult = { type: "replace"; args: JsonObject } | { type: "block"; reason: string } | undefined

export interface AfterToolHookInput extends BeforeToolHookInput {
  title: string
  readOnly: boolean
  output: string
}

export type AfterToolHookResult = { type: "replace"; output: string } | undefined

export interface TurnEndHookInput {
  output?: string | JsonObject
  usage?: Usage
  context?: Usage
}

export interface BeforeCompleteHookInput extends TurnEndHookInput {
  continuationCount: number
}

export type BeforeCompleteHookResult = { type: "block"; reason: string } | undefined

type HookResult<T> = T | Promise<T>

export interface Hook {
  name: string
  timeoutMs?: number
  prompt?(input: PromptHookInput, ctx: HookContext): HookResult<PromptHookResult>
  beforeTool?(input: BeforeToolHookInput, ctx: HookContext): HookResult<BeforeToolHookResult>
  afterTool?(input: AfterToolHookInput, ctx: HookContext): HookResult<AfterToolHookResult>
  beforeComplete?(input: BeforeCompleteHookInput, ctx: HookContext): HookResult<BeforeCompleteHookResult>
  turnEnd?(input: TurnEndHookInput, ctx: HookContext): HookResult<void>
}
