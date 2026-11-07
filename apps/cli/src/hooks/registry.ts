import { describeError } from "../lib/error"
import { asString, isJsonObject, isRecord, type JsonObject } from "../lib/json"
import type {
  AfterToolHookInput,
  BeforeCompleteHookInput,
  BeforeCompleteHookResult,
  BeforeToolHookInput,
  HookAction,
  HookContext,
  HookEvent,
  PromptHookInput,
  TurnEndHookInput,
} from "./types"

type RegisteredHandler = (input: unknown, ctx: HookContext) => unknown

interface RegisteredHook {
  id: string
  pluginOrder: number
  hookOrder: number
  prompt?: RegisteredHandler
  beforeTool?: RegisteredHandler
  afterTool?: RegisteredHandler
  beforeComplete?: RegisteredHandler
  turnEnd?: RegisteredHandler
}

interface ParsedResult<T> {
  value: T
  action: HookAction
}

type PromptStep = { type: "continue" } | { type: "replace"; text: string } | { type: "reject"; reason: string }

type BeforeToolStep = { type: "continue" } | { type: "replace"; args: JsonObject } | { type: "block"; reason: string }

type AfterToolStep = { type: "continue" } | { type: "replace"; output: string }

export interface HookReporter {
  started(hook: string, event: HookEvent): void
  finished(hook: string, event: HookEvent, action: HookAction, elapsedMs: number): void
}

export interface HookDescription {
  id: string
  events: HookEvent[]
}

export type PromptHooksOutcome = { type: "continue"; text: string } | { type: "blocked"; hook: string; reason: string }

export type BeforeCompleteHooksOutcome = { type: "continue" } | { type: "blocked"; hook: string; reason: string }

export type BeforeToolHooksOutcome =
  | { type: "continue"; args: JsonObject; modified: boolean }
  | { type: "blocked"; hook: string; reason: string; args: JsonObject; modified: boolean }

const hooks: RegisteredHook[] = []
const ids = new Set<string>()

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function clearHooks(): void {
  hooks.length = 0
  ids.clear()
}

export function removeHooks(pluginOrder: number): void {
  for (let index = hooks.length - 1; index >= 0; index--) {
    const hook = hooks[index]!
    if (hook.pluginOrder !== pluginOrder) continue
    ids.delete(hook.id)
    hooks.splice(index, 1)
  }
}

function registeredHandler(raw: Record<string, unknown>, name: string): RegisteredHandler | undefined {
  const candidate = raw[name]
  if (candidate === undefined) return undefined
  if (typeof candidate !== "function") throw new Error(`hook ${name} must be a function`)
  return (input, ctx) => Reflect.apply(candidate, raw, [input, ctx])
}

export function registerHook(plugin: string, pluginOrder: number, hookOrder: number, value: unknown): void {
  if (!isRecord(value)) throw new Error("hook must be an object")
  const name = asString(value.name)?.trim()
  if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      "hook name must start with a lower-case letter and contain only letters, numbers, hyphens, or underscores",
    )
  }

  const hook: RegisteredHook = {
    id: `${plugin}/${name}`,
    pluginOrder,
    hookOrder,
    prompt: registeredHandler(value, "prompt"),
    beforeTool: registeredHandler(value, "beforeTool"),
    afterTool: registeredHandler(value, "afterTool"),
    beforeComplete: registeredHandler(value, "beforeComplete"),
    turnEnd: registeredHandler(value, "turnEnd"),
  }
  if (!hook.prompt && !hook.beforeTool && !hook.afterTool && !hook.beforeComplete && !hook.turnEnd) {
    throw new Error(`hook ${hook.id} must register at least one handler`)
  }
  if (ids.has(hook.id)) throw new Error(`hook already registered: ${hook.id}`)

  ids.add(hook.id)
  hooks.push(hook)
  hooks.sort((left, right) => left.pluginOrder - right.pluginOrder || left.hookOrder - right.hookOrder)
}

function eventsOf(hook: RegisteredHook): HookEvent[] {
  const events: HookEvent[] = []
  if (hook.prompt) events.push("prompt")
  if (hook.beforeTool) events.push("before_tool")
  if (hook.afterTool) events.push("after_tool")
  if (hook.beforeComplete) events.push("before_complete")
  if (hook.turnEnd) events.push("turn_end")
  return events
}

export function listHooks(): HookDescription[] {
  return hooks.map((hook) => ({ id: hook.id, events: eventsOf(hook) }))
}

function parsePromptResult(value: unknown): ParsedResult<PromptStep> {
  if (value === undefined) return { value: { type: "continue" }, action: "continued" }
  if (!isRecord(value))
    throw new Error('prompt must return undefined, { type: "replace", text }, or { type: "reject", reason }')
  switch (asString(value.type)) {
    case "replace": {
      const text = asString(value.text)
      if (text === undefined) throw new Error("prompt replacement text must be a string")
      return { value: { type: "replace", text }, action: "modified" }
    }
    case "reject": {
      const reason = asString(value.reason)?.trim()
      if (!reason) throw new Error("prompt rejection reason must be a non-empty string")
      return { value: { type: "reject", reason }, action: "blocked" }
    }
    default:
      throw new Error('prompt result type must be "replace" or "reject"')
  }
}

function parseBeforeToolResult(value: unknown): ParsedResult<BeforeToolStep> {
  if (value === undefined) return { value: { type: "continue" }, action: "continued" }
  if (!isRecord(value)) {
    throw new Error('beforeTool must return undefined, { type: "replace", args }, or { type: "block", reason }')
  }
  switch (asString(value.type)) {
    case "replace":
      if (!isJsonObject(value.args)) throw new Error("beforeTool replacement args must be a JSON object")
      return { value: { type: "replace", args: structuredClone(value.args) }, action: "modified" }
    case "block": {
      const reason = asString(value.reason)?.trim()
      if (!reason) throw new Error("beforeTool block reason must be a non-empty string")
      return { value: { type: "block", reason }, action: "blocked" }
    }
    default:
      throw new Error('beforeTool result type must be "replace" or "block"')
  }
}

function parseAfterToolResult(value: unknown): ParsedResult<AfterToolStep> {
  if (value === undefined) return { value: { type: "continue" }, action: "continued" }
  if (!isRecord(value) || asString(value.type) !== "replace") {
    throw new Error('afterTool must return undefined or { type: "replace", output }')
  }
  const output = asString(value.output)
  if (output === undefined) throw new Error("afterTool replacement output must be a string")
  return { value: { type: "replace", output }, action: "modified" }
}

function parseBeforeCompleteResult(value: unknown): ParsedResult<BeforeCompleteHookResult> {
  if (value === undefined) return { value: undefined, action: "continued" }
  if (!isRecord(value) || asString(value.type) !== "block") {
    throw new Error('beforeComplete must return undefined or { type: "block", reason }')
  }
  const reason = asString(value.reason)?.trim()
  if (!reason) throw new Error("beforeComplete block reason must be a non-empty string")
  if (Array.from(reason).length > 4_000) throw new Error("beforeComplete block reason must be at most 4,000 characters")
  return { value: { type: "block", reason }, action: "blocked" }
}

function parseTurnEndResult(value: unknown): ParsedResult<void> {
  if (value !== undefined) throw new Error("turnEnd must not return a value")
  return { value: undefined, action: "continued" }
}

async function invoke<T>(
  hook: RegisteredHook,
  event: HookEvent,
  handler: RegisteredHandler,
  input: unknown,
  ctx: HookContext,
  reporter: HookReporter,
  parse: (value: unknown) => ParsedResult<T>,
  honorAbort = true,
): Promise<T> {
  reporter.started(hook.id, event)
  const startedAt = Date.now()
  try {
    if (honorAbort) ctx.signal.throwIfAborted()
    const result: unknown = await handler(input, { session: { ...ctx.session }, signal: ctx.signal })
    if (honorAbort) ctx.signal.throwIfAborted()
    const parsed = parse(result)
    reporter.finished(hook.id, event, parsed.action, Date.now() - startedAt)
    return parsed.value
  } catch (error) {
    const interrupted = (honorAbort && ctx.signal.aborted) || isAbortError(error)
    reporter.finished(hook.id, event, interrupted ? "interrupted" : "failed", Date.now() - startedAt)
    if (interrupted) throw error
    throw new Error(`hook ${hook.id} failed during ${event}: ${describeError(error)}`, { cause: error })
  }
}

export async function runPromptHooks(
  input: PromptHookInput,
  ctx: HookContext,
  reporter: HookReporter,
): Promise<PromptHooksOutcome> {
  let text = input.text
  for (const hook of hooks) {
    if (!hook.prompt) continue
    const step = await invoke(hook, "prompt", hook.prompt, { ...input, text }, ctx, reporter, parsePromptResult)
    switch (step.type) {
      case "continue":
        break
      case "replace":
        text = step.text
        break
      case "reject":
        return { type: "blocked", hook: hook.id, reason: step.reason }
    }
  }
  return { type: "continue", text }
}

export async function runBeforeToolHooks(
  input: BeforeToolHookInput,
  ctx: HookContext,
  reporter: HookReporter,
): Promise<BeforeToolHooksOutcome> {
  let args = input.args
  let modified = false
  for (const hook of hooks) {
    if (!hook.beforeTool) continue
    const step = await invoke(
      hook,
      "before_tool",
      hook.beforeTool,
      { ...input, args: structuredClone(args) },
      ctx,
      reporter,
      parseBeforeToolResult,
    )
    switch (step.type) {
      case "continue":
        break
      case "replace":
        args = step.args
        modified = true
        break
      case "block":
        return { type: "blocked", hook: hook.id, reason: step.reason, args, modified }
    }
  }
  return { type: "continue", args, modified }
}

export async function runAfterToolHooks(
  input: AfterToolHookInput,
  ctx: HookContext,
  reporter: HookReporter,
): Promise<string> {
  let output = input.output
  for (const hook of hooks) {
    if (!hook.afterTool) continue
    let step: AfterToolStep
    try {
      step = await invoke(
        hook,
        "after_tool",
        hook.afterTool,
        { ...input, args: structuredClone(input.args), output },
        ctx,
        reporter,
        parseAfterToolResult,
        false,
      )
    } catch (error) {
      if (isAbortError(error)) continue
      throw error
    }
    switch (step.type) {
      case "continue":
        break
      case "replace":
        output = step.output
        break
    }
  }
  return output
}

export async function runBeforeCompleteHooks(
  input: BeforeCompleteHookInput,
  ctx: HookContext,
  reporter: HookReporter,
): Promise<BeforeCompleteHooksOutcome> {
  for (const hook of hooks) {
    if (!hook.beforeComplete) continue
    const step = await invoke(
      hook,
      "before_complete",
      hook.beforeComplete,
      structuredClone(input),
      ctx,
      reporter,
      parseBeforeCompleteResult,
    )
    if (step) return { type: "blocked", hook: hook.id, reason: step.reason }
  }
  return { type: "continue" }
}

export async function runTurnEndHooks(
  input: TurnEndHookInput,
  ctx: HookContext,
  reporter: HookReporter,
): Promise<void> {
  for (const hook of hooks) {
    if (!hook.turnEnd) continue
    const output = typeof input.output === "string" ? input.output : structuredClone(input.output)
    await invoke(
      hook,
      "turn_end",
      hook.turnEnd,
      {
        ...input,
        output,
        ...(input.usage ? { usage: { ...input.usage } } : {}),
        ...(input.context ? { context: { ...input.context } } : {}),
      },
      ctx,
      reporter,
      parseTurnEndResult,
    )
  }
}
