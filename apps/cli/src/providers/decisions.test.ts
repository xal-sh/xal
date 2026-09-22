import { expect, test } from "bun:test"
import type { AgentEvent } from "../agent/events"
import { activeHistory, type HistoryItem } from "../agent/history"
import { runCompaction, type CompactionHost } from "../agent/session/compaction"
import { ContextBudget } from "../agent/session/context-budget"
import { completedRound, ScriptedProvider, setupAgentSessionTests } from "../agent/session/test-support"
import { getCommand } from "../commands/registry"
import type { CommandContext, SelectRequest } from "../commands/types"
import { configureTypeSafeAI } from "../config/typesafe-ai-command"
import { createProfile, deleteProfile, listProfiles } from "../config/credentials"
import { loadSettings, saveSettings, settings } from "../config/settings"
import { listModelChoices } from "./catalog"
import { registerProviderCommands } from "./commands"
import type { DecisionProvider } from "./decision-types"
import { decisions } from "./decisions"
import { getTextProvider, registerProvider } from "./registry"
import type { StreamRequest } from "./types"

function provider(): DecisionProvider {
  return {
    kind: "decision",
    id: "typesafe",
    name: "TypeSafe AI",
    aliases: [],
    async connect() {
      return { type: "api_key", key: "test-token" }
    },
    async listModels() {
      return { source: "runtime", models: [{ kind: "decision", id: "jev-latest", name: "Jev" }] }
    },
    async evaluate(_profile, request) {
      return {
        model: request.model,
        answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0 }])),
        usage: {},
      }
    },
  }
}

test("connecting a decision provider leaves the harness unchanged and exposes only decision runtime operations", async () => {
  const harness = await setupAgentSessionTests("decision-connect-")
  const previous = settings().typesafeAI
  try {
    await loadSettings()
    const text = new ScriptedProvider([])
    registerProvider(text)
    registerProvider(provider())
    const active = await createProfile(text.id, "text", { type: "api_key", key: "text-token" })
    await saveSettings({ provider: text.id, profile: active.id, model: "test-model" })
    const session = harness.createSession(text)
    registerProviderCommands()
    let selections = 0
    const ctx: CommandContext = {
      session,
      print() {},
      busy() {},
      restore() {},
      async ask() {
        return "decisions"
      },
      async askSecret() {
        return "test-token"
      },
      async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
        selections += 1
        return request.options.find((entry) =>
          selections === 1 ? entry.detail === "TypeSafe AI" : entry.label === "On",
        )?.value
      },
    }
    await getCommand("connect")!.run([], ctx)
    expect(settings().provider).toBe(text.id)
    expect(settings().profile).toBe(active.id)
    expect(session.currentProvider).toBe(text)
    expect(getTextProvider("typesafe")).toBeUndefined()
    expect((await listModelChoices()).choices.map((choice) => choice.provider.id)).toEqual([text.id])
    const connected = (await decisions.connections())[0]
    if (!connected) throw new Error("missing decision connection")
    expect((await decisions.models(connected.profile.id)).models[0]?.kind).toBe("decision")
    await configureTypeSafeAI(ctx)
    expect((await loadSettings()).typesafeAI).toEqual({ enabled: true, profile: connected.profile.id })
    expect((await listProfiles()).map((profile) => profile.name)).toEqual(["decisions", "text"])
    await deleteProfile(connected.profile.id)
    await expect(
      decisions.evaluate(connected.profile.id, {
        model: "jev-latest",
        state: "test",
        questions: { needed: { type: "noul", instructions: "Needed?" } },
      }),
    ).rejects.toThrow("not connected")
  } finally {
    settings().typesafeAI = previous
    await harness.cleanup()
  }
})

test("manual and automatic compaction use Jev atomically, with visible summary fallback and no fallback on user cancellation", async () => {
  const harness = await setupAgentSessionTests("decision-compact-")
  const previous = settings().typesafeAI
  try {
    await loadSettings()
    const decision = provider()
    registerProvider(decision)
    const profile = await createProfile("typesafe", "decisions", { type: "api_key", key: "test-token" })
    for (const scenario of ["off", "success", "failure", "insufficient", "cancel", "disconnected"] as const) {
      settings().typesafeAI = scenario === "off" ? { enabled: false } : { enabled: true, profile: profile.id }
      let decisionCalls = 0
      const text = new ScriptedProvider([completedRound("Fallback summary")], 100_000)
      let history: HistoryItem[] = [
        { type: "user_message", text: "User request", images: [] },
        { type: "tool_call", callId: "old", name: "read", args: {} },
        { type: "tool_result", callId: "old", output: "old result ".repeat(4000) },
        ...Array.from({ length: 6 }, (): HistoryItem => ({ type: "assistant_message", text: "recent" })),
      ]
      const original = activeHistory(history)
      const controller = new AbortController()
      const events: AgentEvent[] = []
      const budget = new ContextBudget()
      const build = (items: HistoryItem[]): StreamRequest => ({
        model: "test-model",
        instructions: "Continue",
        tools: [],
        cacheKey: "key",
        input: activeHistory(items),
        toolChoice: "auto",
        sessionId: "session",
      })
      const host: CompactionHost = {
        kind: "primary",
        sessionId: () => "session",
        profileId: () => "text-profile",
        history: () => history,
        contextTokens: () => 12_000,
        buildRequest: () => build(history),
        buildRequestWithHistory: build,
        admitRequest: (provider, request) => budget.admit(provider.id, "text-profile", request),
        onRequestStarted() {},
        observeCompaction() {},
        setState() {},
        replaceHistory(item) {
          history = [item]
        },
        emit(event) {
          events.push(event)
        },
      }
      decision.evaluate = async (_profile, request) => {
        decisionCalls++
        if (scenario === "failure") throw new Error("TypeSafe offline")
        if (scenario === "cancel") controller.abort()
        return {
          model: request.model,
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { type: "noul", noul: scenario === "insufficient" ? 1 : 0 },
            ]),
          ),
          usage: {},
        }
      }
      if (scenario === "disconnected") await deleteProfile(profile.id)
      if (scenario === "cancel") {
        await expect(runCompaction(host, controller.signal, text, "test-model", "manual")).rejects.toThrow()
        expect(history).toEqual(original)
        expect(text.requests).toHaveLength(0)
        expect(events).toEqual([])
        continue
      }
      expect(
        await runCompaction(host, controller.signal, text, "test-model", scenario === "success" ? "auto" : "manual"),
      ).toBe(true)
      expect(history[0]).toMatchObject({ strategy: scenario === "success" ? "jev_v1" : "user_messages_v1" })
      expect(text.requests).toHaveLength(scenario === "success" ? 0 : 1)
      if (scenario === "off") expect(decisionCalls).toBe(0)
      if (scenario !== "success" && scenario !== "off") {
        expect(events.some((event) => event.type === "error" && event.message.includes("falling back"))).toBe(true)
        expect(text.requests[0]?.input).toContainEqual(original[2])
      }
    }
  } finally {
    settings().typesafeAI = previous
    await harness.cleanup()
  }
})

test("decision request redaction protects descriptions without changing question or choice identities", async () => {
  const { replaceSecretValues } = await import("../secrets/redactor")
  const { redactDecisionRequest } = await import("./decision-redaction")
  replaceSecretValues("decision-test", ["sensitive-decision-token"])
  try {
    const request = redactDecisionRequest({
      model: "jev-latest",
      state: { text: "sensitive-decision-token", nested: ["sensitive-decision-token"] },
      questions: {
        needed: {
          type: "noul",
          instructions: "sensitive-decision-token",
          criteria: { true: "sensitive-decision-token", false: null },
        },
        route: {
          type: "choice",
          instructions: null,
          criteria: { keep: { detail: "sensitive-decision-token" }, drop: null },
        },
        score: { type: "score", instructions: "rate", criteria: ["sensitive-decision-token", "good"] },
      },
    })
    expect(JSON.stringify(request)).not.toContain("sensitive-decision-token")
    expect(Object.keys(request.questions)).toEqual(["needed", "route", "score"])
    expect(() => redactDecisionRequest({ ...request, model: "sensitive-decision-token" })).toThrow("identifiers")
  } finally {
    replaceSecretValues("decision-test", [])
  }
})
