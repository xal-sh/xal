import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { replaceSecretValues } from "../secrets/redactor"
import type { BeforeCompleteHookInput, Hook, HookAction, HookContext, HookEvent } from "./types"
import {
  clearHooks,
  listHooks,
  registerHook,
  runAfterToolHooks,
  runBeforeCompleteHooks,
  runBeforeToolHooks,
  runPromptHooks,
  runTurnEndHooks,
  type HookReporter,
} from "./registry"

interface Report {
  type: "started" | "finished"
  hook: string
  event: HookEvent
  action?: HookAction
}

function context(): HookContext {
  return {
    session: {
      id: "session-id",
      kind: "primary",
      cwd: "/workspace",
      provider: "provider",
      profile: "profile",
      model: "model",
      mode: "normal",
    },
    signal: new AbortController().signal,
  }
}

function reporter(reports: Report[]): HookReporter {
  return {
    started(hook, event) {
      reports.push({ type: "started", hook, event })
    },
    finished(hook, event, action) {
      reports.push({ type: "finished", hook, event, action })
    },
  }
}

afterEach(() => {
  clearHooks()
  jest.useRealTimers()
  replaceSecretValues("hook-tests", [])
})

function runHooks(event: HookEvent, ctx: HookContext, reports: Report[]): Promise<unknown> {
  switch (event) {
    case "prompt":
      return runPromptHooks({ text: "hello", imageCount: 0 }, ctx, reporter(reports))
    case "before_tool":
      return runBeforeToolHooks({ callId: "call", tool: "write", args: {} }, ctx, reporter(reports))
    case "after_tool":
      return runAfterToolHooks(
        { callId: "call", tool: "write", args: {}, title: "write", readOnly: false, output: "Written" },
        ctx,
        reporter(reports),
      )
    case "before_complete":
      return runBeforeCompleteHooks({ continuationCount: 0 }, ctx, reporter(reports))
    case "turn_end":
      return runTurnEndHooks({}, ctx, reporter(reports))
  }
}

function registerHandlers(handler: (_input: unknown, ctx: HookContext) => Promise<undefined>): void {
  registerHook("plugin", 0, 0, {
    name: "waiting",
    prompt: handler,
    beforeTool: handler,
    afterTool: handler,
    beforeComplete: handler,
    turnEnd: handler,
  } satisfies Hook)
  registerHook("plugin", 0, 1, {
    name: "unreached",
    prompt: () => {
      throw new Error("must not run")
    },
    beforeTool: () => {
      throw new Error("must not run")
    },
    afterTool: () => {
      throw new Error("must not run")
    },
    beforeComplete: () => {
      throw new Error("must not run")
    },
    turnEnd: () => {
      throw new Error("must not run")
    },
  } satisfies Hook)
}

test("validates hook deadlines before registration", () => {
  for (const timeoutMs of [null, "1000", 0, -1, 1.5, NaN, Infinity, 600_001]) {
    expect(() => registerHook("plugin", 0, 0, { name: "invalid", timeoutMs, prompt() {} })).toThrow(
      "hook timeoutMs must be an integer from 1 to 600000 milliseconds",
    )
  }
  expect(listHooks()).toEqual([])
  for (const timeoutMs of [1, 600_000]) {
    registerHook("plugin", 0, timeoutMs, { name: `valid-${timeoutMs}`, timeoutMs, prompt() {} })
  }
  expect(listHooks()).toHaveLength(2)
})

test.each(["prompt", "before_tool", "after_tool", "before_complete", "turn_end"] satisfies HookEvent[])(
  "bounds an uncooperative %s hook and ignores its late result",
  async (event) => {
    jest.useFakeTimers()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const reports: Report[] = []
    const ctx = context()
    registerHandlers(async (_input, hookContext) => {
      entered.resolve(hookContext.signal)
      return release.promise
    })
    const pending = runHooks(event, ctx, reports).catch((error: unknown) => error)
    const signal = await entered.promise
    jest.advanceTimersByTime(60_000)
    expect(await pending).toMatchObject({
      message: `hook plugin/waiting failed during ${event}: timed out after 60000ms`,
    })
    expect(signal.aborted).toBe(true)
    expect(ctx.signal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
    expect(reports).toEqual([
      { type: "started", hook: "plugin/waiting", event },
      { type: "finished", hook: "plugin/waiting", event, action: "failed" },
    ])
    release.resolve(undefined)
    await release.promise
    await Promise.resolve()
    expect(reports).toHaveLength(2)
  },
)

test.each(["prompt", "before_tool", "before_complete", "turn_end"] satisfies HookEvent[])(
  "interrupts an uncooperative %s hook without starting later handlers",
  async (event) => {
    jest.useFakeTimers()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const reports: Report[] = []
    registerHandlers(async () => {
      entered.resolve()
      return new Promise<undefined>(() => {})
    })
    const ctx = { ...context(), signal: controller.signal }
    const pending = runHooks(event, ctx, reports).catch((error: unknown) => error)
    await entered.promise
    const reason = new Error("Stopped")
    controller.abort(reason)
    expect(await pending).toBe(reason)
    expect(reports.at(-1)?.action).toBe("interrupted")
    expect(reports).toHaveLength(2)
    expect(jest.getTimerCount()).toBe(0)
    await expect(runHooks(event, ctx, reports)).rejects.toBe(reason)
    expect(reports).toHaveLength(4)
  },
)

test("reports unexpected late rejection with redaction but no second terminal hook event", async () => {
  jest.useFakeTimers()
  replaceSecretValues("hook-tests", ["hook-secret"])
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<undefined>()
  const logged = Promise.withResolvers<void>()
  const reports: Report[] = []
  const error = spyOn(console, "error").mockImplementation(() => logged.resolve())
  try {
    registerHook("plugin", 0, 0, {
      name: "late",
      timeoutMs: 10,
      async beforeComplete() {
        entered.resolve()
        return release.promise
      },
    } satisfies Hook)
    const pending = runHooks("before_complete", context(), reports).catch((failure: unknown) => failure)
    await entered.promise
    jest.advanceTimersByTime(10)
    expect(await pending).toMatchObject({ message: expect.stringContaining("timed out after 10ms") })
    release.reject(new Error("cleanup failed: hook-secret"))
    await logged.promise
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      "hook plugin/late failed after before_complete stopped waiting: cleanup failed: [REDACTED]",
    )
    expect(reports).toHaveLength(2)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    error.mockRestore()
  }
})

test("post-tool hooks observe interrupted execution but cannot wait indefinitely", async () => {
  jest.useFakeTimers()
  const entered = Promise.withResolvers<AbortSignal>()
  const controller = new AbortController()
  controller.abort()
  const ctx = { ...context(), signal: controller.signal }
  const reports: Report[] = []
  registerHook("plugin", 0, 0, {
    name: "cleanup",
    timeoutMs: 10,
    async afterTool(_input, hookContext) {
      entered.resolve(hookContext.signal)
      return new Promise<undefined>(() => {})
    },
  } satisfies Hook)
  const pending = runHooks("after_tool", ctx, reports).catch((error: unknown) => error)
  expect((await entered.promise).aborted).toBe(true)
  jest.advanceTimersByTime(10)
  expect(await pending).toMatchObject({ message: "hook plugin/cleanup failed during after_tool: timed out after 10ms" })
  expect(reports.at(-1)?.action).toBe("failed")
  expect(jest.getTimerCount()).toBe(0)
})

describe("hook pipeline", () => {
  test("completion gates preserve inputs, registration order, and stop at the first block", async () => {
    const input: BeforeCompleteHookInput = { output: { ready: true }, usage: { outputTokens: 2 }, continuationCount: 1 }
    const reports: Report[] = []
    const seen: BeforeCompleteHookInput[] = []
    registerHook("plugin", 0, 1, {
      name: "gate",
      beforeComplete(value: BeforeCompleteHookInput) {
        seen.push(value)
        return { type: "block", reason: "  Missing evidence  " }
      },
    })
    registerHook("plugin", 0, 0, {
      name: "observe",
      beforeComplete(value: BeforeCompleteHookInput) {
        value.output = "mutated"
        if (value.usage) value.usage.outputTokens = 100
      },
    })
    registerHook("plugin", 0, 2, {
      name: "unreached",
      beforeComplete() {
        throw new Error("must not run")
      },
    })

    expect(await runBeforeCompleteHooks(input, context(), reporter(reports))).toEqual({
      type: "blocked",
      hook: "plugin/gate",
      reason: "Missing evidence",
    })
    expect(seen).toEqual([input])
    expect(input).toEqual({ output: { ready: true }, usage: { outputTokens: 2 }, continuationCount: 1 })
    expect(listHooks()).toEqual([
      { id: "plugin/observe", events: ["before_complete"] },
      { id: "plugin/gate", events: ["before_complete"] },
      { id: "plugin/unreached", events: ["before_complete"] },
    ])
    expect(reports.filter((entry) => entry.type === "finished")).toEqual([
      { type: "finished", hook: "plugin/observe", event: "before_complete", action: "continued" },
      { type: "finished", hook: "plugin/gate", event: "before_complete", action: "blocked" },
    ])
  })

  test("completion gates fail closed on invalid decisions and oversized feedback", async () => {
    for (const value of [
      null,
      true,
      { type: "continue" },
      { type: "block", reason: " " },
      { type: "block", reason: "x".repeat(4_001) },
    ]) {
      clearHooks()
      const reports: Report[] = []
      registerHook("plugin", 0, 0, { name: "invalid", beforeComplete: () => value })
      await expect(runBeforeCompleteHooks({ continuationCount: 0 }, context(), reporter(reports))).rejects.toThrow(
        "hook plugin/invalid failed during before_complete:",
      )
      expect(reports.at(-1)?.action).toBe("failed")
    }
  })

  test("completion gates honor cancellation after an asynchronous handler", async () => {
    const abort = new AbortController()
    const reports: Report[] = []
    registerHook("plugin", 0, 0, {
      name: "cancelled",
      async beforeComplete() {
        abort.abort(new DOMException("Stopped", "AbortError"))
        return { type: "block", reason: "must not continue" }
      },
    })
    await expect(
      runBeforeCompleteHooks({ continuationCount: 0 }, { ...context(), signal: abort.signal }, reporter(reports)),
    ).rejects.toThrow("Stopped")
    expect(reports.at(-1)?.action).toBe("interrupted")
  })

  test("runs hooks in registration order and chains prompt replacements", async () => {
    const inputs: string[] = []
    const reports: Report[] = []
    registerHook("later", 1, 0, {
      name: "append",
      prompt(input: { text: string }) {
        inputs.push(input.text)
        return { type: "replace", text: `${input.text} world` }
      },
    })
    registerHook("earlier", 0, 1, {
      name: "uppercase",
      prompt(input: { text: string }) {
        inputs.push(input.text)
        return { type: "replace", text: input.text.toUpperCase() }
      },
    })

    const outcome = await runPromptHooks({ text: "hello", imageCount: 0 }, context(), reporter(reports))

    expect(outcome).toEqual({ type: "continue", text: "HELLO world" })
    expect(inputs).toEqual(["hello", "HELLO"])
    expect(reports).toEqual([
      { type: "started", hook: "earlier/uppercase", event: "prompt" },
      { type: "finished", hook: "earlier/uppercase", event: "prompt", action: "modified" },
      { type: "started", hook: "later/append", event: "prompt" },
      { type: "finished", hook: "later/append", event: "prompt", action: "modified" },
    ])
  })

  test("passes replaced tool arguments forward without mutating the caller and stops on a block", async () => {
    const original = { path: "before" }
    const seen: unknown[] = []
    const reports: Report[] = []
    registerHook("plugin", 0, 0, {
      name: "replace",
      beforeTool(input: { args: Record<string, unknown> }) {
        input.args.path = "mutated clone"
        return { type: "replace", args: { path: "after" } }
      },
    })
    registerHook("plugin", 0, 1, {
      name: "block",
      beforeTool(input: { args: Record<string, unknown> }) {
        seen.push(input.args)
        return { type: "block", reason: "unsafe target" }
      },
    })

    const outcome = await runBeforeToolHooks(
      { callId: "call-id", tool: "write", args: original },
      context(),
      reporter(reports),
    )

    expect(original).toEqual({ path: "before" })
    expect(seen).toEqual([{ path: "after" }])
    expect(outcome).toEqual({
      type: "blocked",
      hook: "plugin/block",
      reason: "unsafe target",
      args: { path: "after" },
      modified: true,
    })
    expect(reports.map(({ hook, action }) => ({ hook, action }))).toEqual([
      { hook: "plugin/replace", action: undefined },
      { hook: "plugin/replace", action: "modified" },
      { hook: "plugin/block", action: undefined },
      { hook: "plugin/block", action: "blocked" },
    ])
  })

  test("fails loudly with hook identity and reports the failed lifecycle step", async () => {
    const reports: Report[] = []
    registerHook("plugin", 0, 0, {
      name: "broken",
      prompt() {
        return "invalid"
      },
    })

    await expect(runPromptHooks({ text: "hello", imageCount: 0 }, context(), reporter(reports))).rejects.toThrow(
      'hook plugin/broken failed during prompt: prompt must return undefined, { type: "replace", text }, or { type: "reject", reason }',
    )
    expect(reports.map(({ hook, action }) => ({ hook, action }))).toEqual([
      { hook: "plugin/broken", action: undefined },
      { hook: "plugin/broken", action: "failed" },
    ])
  })
})
