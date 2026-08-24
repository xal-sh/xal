import type { HistoryItem } from "../agent/history"
import type { JsonObject } from "../lib/json"
import { redactJsonObject, redactText } from "../secrets/redactor"
import type { WorkspaceTrust } from "./trust"

const MAX_CONTEXT_CHARS = 60_000

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[truncated]`
}

function boundedArgs(value: JsonObject, maxChars: number): JsonObject {
  const redacted = redactJsonObject(value)
  const serialized = JSON.stringify(redacted)
  if (serialized.length <= maxChars) return redacted
  return { truncated_json: boundedText(serialized, maxChars) }
}

export interface ClassifierPendingAction {
  tool: string
  title: string
  args: JsonObject
  subject: string | undefined
  readOnly: boolean
  sandboxed: boolean
  origin: "model" | "direct_user"
}

export interface ClassifierContext {
  guidance: string
  userMessages: string[]
  priorActions: Array<{ tool: string; args: JsonObject }>
  workspace: WorkspaceTrust & { dirty: boolean | undefined }
  pendingAction: ClassifierPendingAction
}

interface Projection {
  userMessages: string[]
  priorActions: Array<{ tool: string; args: JsonObject }>
}

function projectItem(item: HistoryItem, projection: Projection, pendingCallId: string): void {
  switch (item.type) {
    case "user_message":
      if (item.messageId) projection.userMessages.push(boundedText(redactText(item.text), 8_000))
      return
    case "tool_call":
      if (item.callId !== pendingCallId) {
        projection.priorActions.push({
          tool: boundedText(redactText(item.name), 512),
          args: boundedArgs(item.args, 6_000),
        })
      }
      return
    case "compaction":
      for (const retained of item.retained) projectItem(retained, projection, pendingCallId)
      return
    case "assistant_message":
    case "reasoning":
    case "tool_result":
    case "direct_shell":
      return
    default: {
      const exhaustive: never = item
      return exhaustive
    }
  }
}

function contextLength(context: ClassifierContext): number {
  return JSON.stringify(context).length
}

export function buildClassifierContext(input: {
  guidance: string
  history: HistoryItem[]
  pendingCallId: string
  trust: WorkspaceTrust
  dirty: boolean | undefined
  action: ClassifierPendingAction
}): ClassifierContext {
  const projection: Projection = { userMessages: [], priorActions: [] }
  for (const item of input.history) projectItem(item, projection, input.pendingCallId)
  projection.userMessages = projection.userMessages.slice(-100)
  projection.priorActions = projection.priorActions.slice(-100)
  const context: ClassifierContext = {
    guidance: boundedText(redactText(input.guidance), 12_000),
    userMessages: projection.userMessages,
    priorActions: projection.priorActions,
    workspace: {
      cwd: boundedText(redactText(input.trust.cwd), 2_000),
      root: boundedText(redactText(input.trust.root), 2_000),
      remotes: input.trust.remotes.slice(0, 10).map((remote) => boundedText(redactText(remote), 512)),
      dirty: input.dirty,
    },
    pendingAction: {
      tool: boundedText(redactText(input.action.tool), 512),
      title: boundedText(redactText(input.action.title), 2_000),
      args: boundedArgs(input.action.args, 16_000),
      subject: input.action.subject === undefined ? undefined : boundedText(redactText(input.action.subject), 2_000),
      readOnly: input.action.readOnly,
      sandboxed: input.action.sandboxed,
      origin: input.action.origin,
    },
  }
  while (context.priorActions.length > 0 && contextLength(context) > MAX_CONTEXT_CHARS) {
    context.priorActions.shift()
  }
  while (context.userMessages.length > 1 && contextLength(context) > MAX_CONTEXT_CHARS) {
    context.userMessages.shift()
  }
  if (contextLength(context) <= MAX_CONTEXT_CHARS) return context
  context.guidance = boundedText(context.guidance, 6_000)
  context.userMessages = context.userMessages.map((message) => boundedText(message, 4_000))
  context.workspace.cwd = boundedText(context.workspace.cwd, 1_000)
  context.workspace.root = boundedText(context.workspace.root, 1_000)
  context.workspace.remotes = context.workspace.remotes.map((remote) => boundedText(remote, 256))
  context.pendingAction.title = boundedText(context.pendingAction.title, 1_000)
  context.pendingAction.args = boundedArgs(input.action.args, 8_000)
  if (context.pendingAction.subject !== undefined) {
    context.pendingAction.subject = boundedText(context.pendingAction.subject, 1_000)
  }
  if (contextLength(context) > MAX_CONTEXT_CHARS)
    throw new Error("permission classifier context exceeds its hard limit")
  return context
}
