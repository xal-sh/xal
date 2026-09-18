import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { getJob } from "../../background/jobs"
import type { CommandContext, SelectRequest } from "../../commands/types"
import { createProfile, deleteProfile } from "../../config/credentials"
import { configureReasoningRouting, reasoningRoutingConfigAvailable } from "../../config/reasoning-routing-command"
import { loadSettings, settings } from "../../config/settings"
import type { DecisionProvider } from "../../providers/decision-types"
import { registerProvider } from "../../providers/registry"
import type { StreamRequest } from "../../providers/types"
import { registerBasePrompt } from "../prompt/base"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
} from "../session/test-support"
import { registerTaskAgents } from "./tool"

test("opt-in routing reaches the child provider, preserves parent and explicit/write effort, and logs its decision", async () => {
  const harness = await setupAgentSessionTests("reasoning-startup-")
  const previous = settings().reasoningRouting
  let calls = 0
  const decisionProvider: DecisionProvider = {
    kind: "decision",
    id: "typesafe",
    name: "TypeSafe",
    aliases: [],
    async listModels() {
      return { source: "runtime", models: [{ kind: "decision", id: "jev-latest", name: "Jev" }] }
    },
    async evaluate() {
      calls++
      return { model: "jev-test", answers: { routine_lookup: { type: "noul", noul: 0.99 } }, usage: {} }
    },
  }
  const provider = new ScriptedProvider([])
  provider.listModels = async () => ({
    source: "runtime",
    models: [
      {
        kind: "text",
        id: "test-model",
        name: "Test",
        inputModalities: ["text"],
        thinking: { options: ["low", "high"], default: "high" },
      },
    ],
  })
  const session = harness.createSession(provider, { interactive: true })
  const requests: StreamRequest[] = []
  const names = ["routed_lookup", "explicit_lookup", "writer_lookup"]
  let dispatched = false
  provider.stream = async function* (_profileId, request) {
    requests.push(request)
    if (request.sessionId !== session.id) {
      yield* completedRound("Looked up the fact.")(request)
      return
    }
    if (!dispatched) {
      dispatched = true
      yield* toolRound("dispatch-routing", "task", {
        context: "Locate a named function without reviewing it.",
        tasks: [
          { name: names[0]!, task: "Locate resolveThinking", access: "read" },
          { name: names[1]!, task: "Locate resolveThinking explicitly", access: "read", thinking: "high" },
          { name: names[2]!, task: "Locate resolveThinking with write access", access: "write" },
        ],
      })(request)
      return
    }
    for (const name of names) {
      const job = getJob(name)
      if (!job) throw new Error(`missing task ${name}`)
      await job.completion
    }
    yield* completedRound("All task results received.")(request)
  }
  try {
    await loadSettings()
    expect(await reasoningRoutingConfigAvailable()).toBe(false)
    registerProvider(decisionProvider)
    const profile = await createProfile("typesafe", "Routing", { type: "api_key", key: "routing-test-key" })
    expect(await reasoningRoutingConfigAvailable()).toBe(true)
    let enable = true
    const ctx: CommandContext = {
      session,
      print() {},
      busy() {},
      restore() {},
      async ask() {
        return undefined
      },
      async askSecret() {
        return undefined
      },
      async select<T>(request: SelectRequest<T>) {
        const option = request.options.find((option) =>
          enable ? option.label.startsWith("Jev") : option.label === "Reasoning routing off",
        )
        if (enable) expect(option?.detail).toContain("task descriptions and shared context to TypeSafe")
        return option?.value
      },
    }
    await configureReasoningRouting(ctx)
    expect((await loadSettings()).reasoningRouting).toEqual({ strategy: "jev", profile: profile.id })
    expect(settings().codeSearch).toEqual({ strategy: "off" })
    expect(settings().compaction).toEqual({ strategy: "summary" })
    registerBasePrompt()
    registerTaskAgents()
    session.setThinking("high")
    session.setMode("yolo")
    expect((await runSettledTurn(session, { text: "Delegate the three lookup tasks.", images: [] })).status).toBe(
      "completed",
    )
    expect(calls).toBe(1)
    expect(
      requests.filter((request) => request.sessionId === session.id).every((request) => request.thinking === "high"),
    ).toBe(true)
    expect(
      requests
        .filter((request) => request.sessionId !== session.id)
        .map((request) => request.thinking)
        .sort(),
    ).toEqual(["high", "high", "low"])
    for (const name of names) {
      const job = getJob(name)
      if (job?.kind !== "agent" || job.record?.status !== "saved") throw new Error("missing saved task record")
      const transcript = await readFile(job.record.path, "utf8")
      expect(transcript).toContain("Reasoning routing:")
      expect(transcript).toContain(
        name === names[0]
          ? "routine lookup (Jev score 0.99)"
          : name === names[1]
            ? "explicit task effort"
            : "write task; routing is read-only",
      )
    }
    await deleteProfile(profile.id)
    expect(await reasoningRoutingConfigAvailable()).toBe(true)
    enable = false
    await configureReasoningRouting(ctx)
    expect((await loadSettings()).reasoningRouting).toEqual({ strategy: "off" })
    expect(await reasoningRoutingConfigAvailable()).toBe(false)
  } finally {
    await session.cancelAndReapAsyncWork()
    session.disposeAsyncDelivery()
    session.disposeToolResources()
    settings().reasoningRouting = previous
    await harness.cleanup()
  }
})
