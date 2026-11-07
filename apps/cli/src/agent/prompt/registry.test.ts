import { expect, test } from "bun:test"
import type { JsonObject } from "../../lib/json"
import { prepareSystemPrompt, registerPrompt, type PromptContext } from "./registry"

const context: PromptContext = {
  sessionId: "session",
  appName: "xal",
  platform: "test",
  cwd: "/repo",
  kind: "primary",
  tools: [],
  mode: "normal",
}

test("prepares from a copy of saved state and propagates persistence failure and cancellation", async () => {
  const states = new Map<string, JsonObject>([["prepared", { paths: ["src/AGENTS.md"] }]])
  let prepares = 0
  registerPrompt({
    id: "prepared",
    async prepare(ctx, state) {
      prepares++
      expect(ctx.cwd).toBe("/repo")
      expect(state).toEqual({ paths: ["src/AGENTS.md"] })
      if (!state) throw new Error("missing state")
      state.cwd = ctx.cwd
      return state
    },
    text: () => "",
  })
  await expect(
    prepareSystemPrompt(context, states, new AbortController().signal, async () => {
      throw new Error("disk unavailable")
    }),
  ).rejects.toThrow("disk unavailable")
  expect(states.get("prepared")).toEqual({ paths: ["src/AGENTS.md"] })
  await expect(prepareSystemPrompt(context, states, AbortSignal.abort(), async () => {})).rejects.toThrow()
  expect(prepares).toBe(1)
  const controller = new AbortController()
  await expect(
    prepareSystemPrompt(context, states, controller.signal, async () => controller.abort()),
  ).rejects.toThrow()
  expect(() => registerPrompt({ id: "prepared", prepare: async () => undefined, text: () => "" })).toThrow(
    "already has a preparation handler",
  )
})
