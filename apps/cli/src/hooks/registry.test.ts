import { afterEach, describe, expect, test } from "bun:test"
import type { BeforeCompleteHookInput, HookAction, HookContext, HookEvent } from "./types"
import {
  clearHooks,
  listHooks,
  registerHook,
  runBeforeCompleteHooks,
  runBeforeToolHooks,
  runPromptHooks,
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
