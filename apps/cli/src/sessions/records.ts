import type {
  AgentEvent,
  AgentQuestionEventItem,
  BackgroundResult,
  DenialCause,
  DirectShellResult,
} from "../agent/events"
import type { CompactionItem, HistoryItem } from "../agent/history"
import { isMessageId } from "../agent/message-id"
import { parseGoalSnapshot } from "../goals/types"
import type { HookAction, HookEvent } from "../hooks/types"
import { asBoolean, asNumber, asString, isJsonObject, isRecord } from "../lib/json"
import { defaultPermissionMode, isPermissionMode } from "../permissions/modes"
import { parseSessionPlan } from "../plans/types"
import {
  isThinkingEffort,
  type ConversationItem,
  type ImageInput,
  type ProviderReplay,
  type ThinkingEffort,
  type Usage,
  type UserMessageItem,
} from "../providers/types"
import { parseTaskList } from "../tasks/types"
import type { ProcessExecution, ProcessSandbox } from "../tools/types"
import { normalizeSessionTitle } from "./title"
import type { SessionMeta, SessionRecord } from "./types"

export function isPersistable(event: AgentEvent): boolean {
  return parseEvent(event) !== undefined
}

function parseDenial(value: unknown): DenialCause | undefined {
  const denial = asString(value)
  if (denial === "user" || denial === "policy" || denial === "plan" || denial === "hook") return denial
  return undefined
}

function parseProcessExecution(value: unknown): ProcessExecution | undefined {
  if (!isRecord(value)) return undefined
  const status = asString(value.status)
  const sandbox = asString(value.sandbox)
  if (value.sandbox !== undefined && sandbox !== "read" && sandbox !== "workspace") return undefined
  const processSandbox: ProcessSandbox | undefined = sandbox === "read" || sandbox === "workspace" ? sandbox : undefined
  const sandboxed = processSandbox ? { sandbox: processSandbox } : {}
  if (status === "exited") {
    const exitCode = asNumber(value.exitCode)
    return exitCode !== undefined && Number.isSafeInteger(exitCode) ? { status, exitCode, ...sandboxed } : undefined
  }
  if (status === "signaled") {
    const signal = asString(value.signal)
    if (value.signal !== undefined && !signal) return undefined
    return { status, ...(signal === undefined ? {} : { signal }), ...sandboxed }
  }
  if (status === "timed_out") {
    const timeoutSeconds = asNumber(value.timeoutSeconds)
    return timeoutSeconds !== undefined && Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0
      ? { status, timeoutSeconds, ...sandboxed }
      : undefined
  }
  if (status === "interrupted") return { status, ...sandboxed }
  return undefined
}

function parseDirectShell(raw: Record<string, unknown>): DirectShellResult | undefined {
  const callId = asString(raw.callId)
  const input = asString(raw.input)
  const command = asString(raw.command)
  const output = asString(raw.output)
  const readOnly = asBoolean(raw.readOnly)
  const denial = parseDenial(raw.denial)
  if (
    !isMessageId(raw.messageId) ||
    !callId ||
    input === undefined ||
    command === undefined ||
    output === undefined ||
    readOnly === undefined ||
    (raw.denial !== undefined && denial === undefined)
  ) {
    return undefined
  }
  return {
    messageId: raw.messageId,
    callId,
    input,
    command,
    output,
    readOnly,
    ...(denial ? { denial } : {}),
  }
}

function parseHookEvent(value: unknown): HookEvent | undefined {
  const event = asString(value)
  if (event === "prompt" || event === "before_tool" || event === "after_tool" || event === "turn_end") return event
  return undefined
}

function parseHookAction(value: unknown): HookAction | undefined {
  const action = asString(value)
  if (
    action === "continued" ||
    action === "modified" ||
    action === "blocked" ||
    action === "failed" ||
    action === "interrupted"
  ) {
    return action
  }
  return undefined
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  return {
    totalInputTokens: asNumber(value.totalInputTokens),
    cacheReadInputTokens: asNumber(value.cacheReadInputTokens),
    cacheWriteInputTokens: asNumber(value.cacheWriteInputTokens),
    outputTokens: asNumber(value.outputTokens),
  }
}

function parseThinking(value: unknown): ThinkingEffort | undefined {
  return isThinkingEffort(value) ? value : undefined
}

function parseConversationMove(
  raw: Record<string, unknown>,
): { messageId: string; prompt: string; fileCount: number } | undefined {
  const prompt = asString(raw.prompt)
  const fileCount = asNumber(raw.fileCount)
  if (
    !isMessageId(raw.messageId) ||
    prompt === undefined ||
    fileCount === undefined ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 0
  ) {
    return undefined
  }
  return { messageId: raw.messageId, prompt, fileCount }
}

function parseMessageIdentity(raw: Record<string, unknown>): { messageId?: string } | undefined {
  if (raw.messageId === undefined) return {}
  return isMessageId(raw.messageId) ? { messageId: raw.messageId } : undefined
}

function parseBackgroundResult(value: unknown): BackgroundResult | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const status = asString(value.status)
  const output = asString(value.output)
  if (!id || output === undefined) return undefined
  if (value.kind === "agent") {
    const task = asString(value.task)
    if (task === undefined) return undefined
    if (status !== "completed" && status !== "failed" && status !== "interrupted" && status !== "timed_out") {
      return undefined
    }
    return { kind: "agent", id, task, status, output }
  }
  if (value.kind === "process") {
    const command = asString(value.command)
    if (command === undefined) return undefined
    if (status !== "completed" && status !== "failed" && status !== "interrupted") return undefined
    const exitCode = asNumber(value.exitCode)
    const signal = asString(value.signal)
    const record = asString(value.record)
    const recordCapped = asBoolean(value.recordCapped)
    return {
      kind: "process",
      id,
      command,
      status,
      output,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
      ...(record === undefined ? {} : { record }),
      ...(recordCapped === undefined ? {} : { recordCapped }),
    }
  }
  return undefined
}

function parseAgentQuestion(value: unknown): AgentQuestionEventItem | undefined {
  if (!isRecord(value)) return undefined
  const requestId = asString(value.requestId)
  const jobId = asString(value.jobId)
  const question = asString(value.question)
  if (!requestId || !jobId || !question) return undefined
  return { requestId, jobId, question }
}

function parseEvent(raw: unknown): AgentEvent | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "session_title_changed": {
      const title = asString(raw.title)
      if (!title || normalizeSessionTitle(title) !== title) return undefined
      return { type: "session_title_changed", title }
    }
    case "workspace_changed": {
      const cwd = asString(raw.cwd)
      const previous = asString(raw.previous)
      if (!cwd || !previous) return undefined
      return { type: "workspace_changed", cwd, previous }
    }
    case "task_list_updated": {
      const tasks = parseTaskList(raw.tasks)
      const explanation = asString(raw.explanation)
      if (!tasks) return undefined
      return { type: "task_list_updated", tasks, ...(explanation === undefined ? {} : { explanation }) }
    }
    case "plan_updated": {
      const plan = parseSessionPlan(raw.plan)
      return plan ? { type: "plan_updated", plan } : undefined
    }
    case "goal_updated": {
      const goal = parseGoalSnapshot(raw.goal)
      return goal ? { type: "goal_updated", goal } : undefined
    }
    case "user_message": {
      const text = asString(raw.text)
      const identity = parseMessageIdentity(raw)
      if (text === undefined || !identity) return undefined
      return {
        type: "user_message",
        ...identity,
        text,
        imageCount: asNumber(raw.imageCount) ?? 0,
        sentAt: asNumber(raw.sentAt) ?? 0,
      }
    }
    case "background_results": {
      if (!Array.isArray(raw.results) || raw.results.length === 0) return undefined
      const results = raw.results.flatMap((value) => {
        const result = parseBackgroundResult(value)
        return result ? [result] : []
      })
      return results.length === raw.results.length ? { type: "background_results", results } : undefined
    }
    case "agent_questions": {
      if (!Array.isArray(raw.questions) || raw.questions.length === 0) return undefined
      const questions = raw.questions.flatMap((value) => {
        const question = parseAgentQuestion(value)
        return question ? [question] : []
      })
      return questions.length === raw.questions.length ? { type: "agent_questions", questions } : undefined
    }
    case "conversation_rewound": {
      const movement = parseConversationMove(raw)
      const removedMessages = asNumber(raw.removedMessages)
      if (!movement || removedMessages === undefined || !Number.isSafeInteger(removedMessages) || removedMessages < 1) {
        return undefined
      }
      return { type: "conversation_rewound", ...movement, removedMessages }
    }
    case "conversation_redone": {
      const movement = parseConversationMove(raw)
      const restoredMessages = asNumber(raw.restoredMessages)
      if (
        !movement ||
        restoredMessages === undefined ||
        !Number.isSafeInteger(restoredMessages) ||
        restoredMessages < 1
      ) {
        return undefined
      }
      return { type: "conversation_redone", ...movement, restoredMessages }
    }
    case "hook_finished": {
      const hook = asString(raw.hook)
      const event = parseHookEvent(raw.event)
      const action = parseHookAction(raw.action)
      const elapsedMs = asNumber(raw.elapsedMs)
      if (!hook || !event || !action || elapsedMs === undefined) return undefined
      return { type: "hook_finished", hook, event, action, elapsedMs }
    }
    case "tool_call_updated": {
      const callId = asString(raw.callId)
      const tool = asString(raw.tool)
      if (!callId || !tool || !isJsonObject(raw.args)) return undefined
      return { type: "tool_call_updated", callId, tool, args: raw.args }
    }
    case "assistant_message": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return { type: "assistant_message", text }
    }
    case "reasoning_summary": {
      const text = asString(raw.text)
      if (text === undefined) return undefined
      return { type: "reasoning_summary", text }
    }
    case "tool_finished": {
      const callId = asString(raw.callId)
      const tool = asString(raw.tool)
      const title = asString(raw.title)
      const output = asString(raw.output)
      const execution = parseProcessExecution(raw.execution)
      if (
        !callId ||
        !tool ||
        title === undefined ||
        output === undefined ||
        (raw.execution !== undefined && execution === undefined)
      ) {
        return undefined
      }
      return {
        type: "tool_finished",
        callId,
        tool,
        title,
        readOnly: asBoolean(raw.readOnly) ?? false,
        output,
        ...(execution ? { execution } : {}),
        denial: parseDenial(raw.denial),
      }
    }
    case "shell_finished": {
      const shell = parseDirectShell(raw)
      const execution = parseProcessExecution(raw.execution)
      if (!shell || (raw.execution !== undefined && execution === undefined)) return undefined
      return { type: "shell_finished", ...shell, ...(execution ? { execution } : {}) }
    }
    case "compacted": {
      const summary = asString(raw.summary)
      const replaced = asNumber(raw.replaced)
      if (!summary || replaced === undefined) return undefined
      return { type: "compacted", summary, replaced, tokensBefore: asNumber(raw.tokensBefore) }
    }
    case "turn_ended": {
      if (raw.output !== undefined && !isJsonObject(raw.output)) return undefined
      return {
        type: "turn_ended",
        usage: parseUsage(raw.usage),
        context: parseUsage(raw.context),
        output: raw.output,
      }
    }
    case "turn_failed": {
      const message = asString(raw.message)
      if (message === undefined) return undefined
      return { type: "turn_failed", message, usage: parseUsage(raw.usage), context: parseUsage(raw.context) }
    }
    case "turn_interrupted":
      return { type: "turn_interrupted" }
    case "mode_changed": {
      const mode = asString(raw.mode)
      if (!mode) return undefined
      return { type: "mode_changed", mode: isPermissionMode(mode) ? mode : defaultPermissionMode }
    }
    case "model_changed": {
      const provider = asString(raw.provider)
      const profile = raw.profile === undefined ? undefined : asString(raw.profile)
      const model = asString(raw.model)
      if (!provider || (raw.profile !== undefined && !profile) || !model) return undefined
      return { type: "model_changed", provider, profile, model }
    }
    case "thinking_changed":
      return { type: "thinking_changed", thinking: parseThinking(raw.thinking) }
    case "error": {
      const message = asString(raw.message)
      if (message === undefined) return undefined
      return { type: "error", message }
    }
    default:
      return undefined
  }
}

function parseMeta(raw: unknown): SessionMeta | undefined {
  if (!isRecord(raw)) return undefined
  if (asNumber(raw.version) !== 2) return undefined
  const id = asString(raw.id)
  const parentId = asString(raw.parentId)
  const cwd = asString(raw.cwd)
  const provider = asString(raw.provider)
  const profile = asString(raw.profile)
  const model = asString(raw.model)
  const mode = asString(raw.mode)
  const modeBeforePlan = asString(raw.modeBeforePlan)
  if (
    !id ||
    (raw.parentId !== undefined && !parentId) ||
    !cwd ||
    !provider ||
    (raw.profile !== undefined && !profile) ||
    !model ||
    !mode ||
    (raw.modeBeforePlan !== undefined && !modeBeforePlan)
  ) {
    return undefined
  }
  return {
    version: 2,
    id,
    ...(parentId ? { parentId } : {}),
    cwd,
    provider,
    ...(profile ? { profile } : {}),
    model,
    thinking: parseThinking(raw.thinking),
    mode: isPermissionMode(mode) ? mode : defaultPermissionMode,
    ...(modeBeforePlan
      ? { modeBeforePlan: isPermissionMode(modeBeforePlan) ? modeBeforePlan : defaultPermissionMode }
      : {}),
    startedAt: asNumber(raw.startedAt) ?? 0,
  }
}

function parseReplay(raw: unknown): ProviderReplay | undefined {
  if (!isRecord(raw)) return undefined
  const provider = asString(raw.provider)
  if (!provider || !isJsonObject(raw.data)) return undefined
  if (raw.model === undefined) return { provider, data: raw.data }
  const model = asString(raw.model)
  return model ? { provider, model, data: raw.data } : undefined
}

function parseOptionalReplay(raw: Record<string, unknown>): { replay?: ProviderReplay } | undefined {
  if (raw.replay === undefined) return {}
  const replay = parseReplay(raw.replay)
  return replay ? { replay } : undefined
}

function parseImage(raw: unknown): ImageInput | undefined {
  if (!isRecord(raw)) return undefined
  const mediaType = asString(raw.mediaType)
  const data = asString(raw.data)
  if ((mediaType !== "image/png" && mediaType !== "image/jpeg") || !data) return undefined
  if (data.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data)) return undefined
  return { mediaType, data }
}

function parseImages(raw: unknown): ImageInput[] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const images = raw.flatMap((image) => {
    const parsed = parseImage(image)
    return parsed ? [parsed] : []
  })
  return images.length === raw.length ? images : undefined
}

function parseConversationItem(raw: unknown): ConversationItem | undefined {
  if (!isRecord(raw)) return undefined

  switch (asString(raw.type)) {
    case "user_message": {
      const text = asString(raw.text)
      const images = parseImages(raw.images)
      const identity = parseMessageIdentity(raw)
      if (text === undefined || !images || !identity) return undefined
      if (raw.modelText === undefined) return { type: "user_message", text, images, ...identity }
      const modelText = asString(raw.modelText)
      return modelText === undefined ? undefined : { type: "user_message", text, images, ...identity, modelText }
    }
    case "assistant_message": {
      const text = asString(raw.text)
      const replay = parseOptionalReplay(raw)
      if (text === undefined || !replay) return undefined
      return { type: "assistant_message", text, ...replay }
    }
    case "reasoning": {
      const summary = asString(raw.summary)
      const replay = parseOptionalReplay(raw)
      if (summary === undefined || !replay) return undefined
      return { type: "reasoning", summary, ...replay }
    }
    case "tool_call": {
      const callId = asString(raw.callId)
      const name = asString(raw.name)
      const replay = parseOptionalReplay(raw)
      if (!callId || !name || !isJsonObject(raw.args) || !replay) return undefined
      return { type: "tool_call", callId, name, args: raw.args, ...replay }
    }
    case "tool_result": {
      const callId = asString(raw.callId)
      const output = asString(raw.output)
      if (!callId || output === undefined) return undefined
      return { type: "tool_result", callId, output }
    }
    default:
      return undefined
  }
}

function parseCompaction(raw: Record<string, unknown>): CompactionItem | undefined {
  const summary = asString(raw.summary)
  const replaced = asNumber(raw.replaced)
  if (!summary || replaced === undefined || !Array.isArray(raw.retained)) return undefined
  const strategy = asString(raw.strategy)
  if (raw.strategy !== undefined && strategy !== "user_messages_v1") return undefined
  const tokensBefore = asNumber(raw.tokensBefore)
  if (raw.tokensBefore !== undefined && tokensBefore === undefined) return undefined
  if (strategy === "user_messages_v1") {
    const retained: UserMessageItem[] = []
    for (const entry of raw.retained) {
      const item = parseConversationItem(entry)
      if (!item || item.type !== "user_message" || !isMessageId(item.messageId) || item.images.length !== 0) {
        return undefined
      }
      retained.push(item)
    }
    return { type: "compaction", strategy, summary, replaced, tokensBefore, retained }
  }
  const retained: ConversationItem[] = []
  for (const entry of raw.retained) {
    const item = parseConversationItem(entry)
    if (!item) return undefined
    retained.push(item)
  }
  return { type: "compaction", summary, replaced, tokensBefore, retained }
}

function parseItem(raw: unknown): HistoryItem | undefined {
  if (isRecord(raw) && asString(raw.type) === "direct_shell") {
    const shell = parseDirectShell(raw)
    return shell ? { type: "direct_shell", ...shell } : undefined
  }
  if (isRecord(raw) && asString(raw.type) === "compaction") return parseCompaction(raw)
  return parseConversationItem(raw)
}

export function parseRecord(line: string): SessionRecord {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    throw new Error("malformed session record")
  }
  if (!isRecord(raw)) throw new Error("malformed session record")

  switch (asString(raw.type)) {
    case "meta": {
      const meta = parseMeta(raw.meta)
      if (meta) return { type: "meta", meta }
      break
    }
    case "item": {
      const item = parseItem(raw.item)
      if (item) return { type: "item", item }
      break
    }
    case "event": {
      const event = parseEvent(raw.event)
      if (event) return { type: "event", event }
      break
    }
  }
  throw new Error("malformed session record")
}
