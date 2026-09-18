import { expect, test } from "bun:test"
import { completedRound, runSettledTurn, ScriptedProvider, setupAgentSessionTests } from "../agent/session/test-support"
import type { CommandContext, SelectRequest } from "../commands/types"
import { registerBasePrompt } from "../agent/prompt/base"
import { decisions } from "../providers/decisions"
import type { DecisionProvider } from "../providers/decision-types"
import { registerProvider } from "../providers/registry"
import { createProfile, deleteProfile } from "./credentials"
import { loadSettings, saveSettings, settings } from "./settings"
import { configureTypeSafeAI } from "./typesafe-ai-command"

const provider: DecisionProvider = {
  kind: "decision",
  id: "typesafe",
  name: "TypeSafe",
  aliases: [],
  async listModels() {
    return { models: [{ kind: "decision", id: "jev-latest", name: "Jev" }], source: "runtime" }
  },
  async evaluate(_profile, request) {
    return { model: request.model, answers: {}, usage: {} }
  },
}

function context(session: CommandContext["session"], select: CommandContext["select"]): CommandContext {
  return {
    session,
    select,
    print() {},
    busy() {},
    restore() {},
    async ask() {
      return undefined
    },
    async askSecret() {
      return undefined
    },
  }
}

test("one choice enables TypeSafe without changing thinking, reuses the profile, and disables it after disconnect", async () => {
  const harness = await setupAgentSessionTests("typesafe-config-")
  const previous = settings().typesafeAI
  try {
    await loadSettings()
    registerProvider(provider)
    const session = harness.createSession(new ScriptedProvider([]))
    let enabled = true
    let selections = 0
    const ctx = context(session, async <T>(request: SelectRequest<T>) => {
      selections++
      expect(request.options.map((option) => option.label)).toEqual(["On", "Off"])
      const option = request.options.find((option) => option.label === (enabled ? "On" : "Off"))
      if (enabled) {
        for (const disclosure of ["compaction", "conversation", "tool names and inputs"])
          expect(option?.detail).toContain(disclosure)
      }
      return option?.value
    })
    await expect(configureTypeSafeAI(ctx)).rejects.toThrow("connect TypeSafe")
    expect(settings().typesafeAI.enabled).toBe(false)
    const profile = await createProfile("typesafe", "decisions", { type: "api_key", key: "test-key" })
    session.setThinking("high")
    await configureTypeSafeAI(ctx)
    expect((await loadSettings()).typesafeAI).toEqual({ enabled: true, profile: profile.id })
    expect(session.currentThinking).toBe("high")
    await createProfile("typesafe", "another account", { type: "api_key", key: "other-key" })
    await configureTypeSafeAI(ctx)
    expect(selections).toBe(3)
    await deleteProfile(profile.id)
    enabled = false
    await configureTypeSafeAI(ctx)
    expect((await loadSettings()).typesafeAI).toEqual({ enabled: false, profile: profile.id })
    expect(session.currentThinking).toBe("high")
    session.disposeAsyncDelivery()
    session.disposeToolResources()
  } finally {
    settings().typesafeAI = previous
    await harness.cleanup()
  }
})

test("multiple connections require a choice; cancellation and a turn starting during selection do not save", async () => {
  const harness = await setupAgentSessionTests("typesafe-choose-")
  try {
    await loadSettings()
    registerProvider(provider)
    registerBasePrompt()
    await createProfile("typesafe", "first", { type: "api_key", key: "one" })
    const second = await createProfile("typesafe", "second", { type: "api_key", key: "two" })
    const session = harness.createSession(new ScriptedProvider([]))
    let cancel = true
    const ctx = context(session, async <T>(request: SelectRequest<T>) => {
      if (request.options.some((option) => option.label === "On"))
        return request.options.find((option) => option.label === "On")?.value
      return cancel ? undefined : request.options.find((option) => option.label === "second")?.value
    })
    await configureTypeSafeAI(ctx)
    expect(settings().typesafeAI.enabled).toBe(false)
    cancel = false
    await configureTypeSafeAI(ctx)
    expect(settings().typesafeAI).toEqual({ enabled: true, profile: second.id })
    const busy = context(session, async <T>(request: SelectRequest<T>) => {
      expect(session.send({ text: "start work", images: [] })).toBe(true)
      return request.options.find((option) => option.label === "Off")?.value
    })
    await expect(configureTypeSafeAI(busy)).rejects.toThrow("while a turn is running")
    expect((await loadSettings()).typesafeAI.enabled).toBe(true)
    session.interrupt()
    await session.cancelAndReapAsyncWork()
    session.disposeAsyncDelivery()
    session.disposeToolResources()
  } finally {
    await harness.cleanup()
  }
})

test("the decision boundary blocks every TypeSafe call while off or using a stale profile", async () => {
  const harness = await setupAgentSessionTests("typesafe-gate-")
  let calls = 0
  try {
    await loadSettings()
    registerProvider({
      ...provider,
      async evaluate(_profile, request) {
        calls++
        return { model: request.model, answers: {}, usage: {} }
      },
    })
    const profile = await createProfile("typesafe", "decisions", { type: "api_key", key: "test-key" })
    const request = { model: "jev-latest", state: "context", questions: {} }
    await expect(decisions.evaluate(profile.id, request)).rejects.toThrow("TypeSafe AI is off")
    await saveSettings({ typesafeAI: { enabled: true, profile: "different-profile" } })
    await expect(decisions.evaluate(profile.id, request)).rejects.toThrow("profile changed")
    expect(calls).toBe(0)
    await saveSettings({ typesafeAI: { enabled: true, profile: profile.id } })
    await decisions.evaluate(profile.id, request)
    expect(calls).toBe(1)
    registerBasePrompt()
    const textProvider = new ScriptedProvider([completedRound("Done")])
    const session = harness.createSession(textProvider)
    try {
      session.setThinking("high")
      expect((await runSettledTurn(session, { text: "Explain this function", images: [] })).status).toBe("completed")
      expect(textProvider.requests.map((entry) => entry.thinking)).toEqual(["high"])
      expect(calls).toBe(1)
    } finally {
      session.disposeAsyncDelivery()
      session.disposeToolResources()
    }
    await saveSettings({ typesafeAI: { enabled: false } })
    await expect(decisions.evaluate(profile.id, request)).rejects.toThrow("TypeSafe AI is off")
    expect(calls).toBe(1)
  } finally {
    await harness.cleanup()
  }
})
