import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConversationItem, StreamRequest } from "../../providers/types"
import { parseRecord } from "../../sessions/records"
import * as output from "../../tools/output"
import { activeHistory, type HistoryItem } from "../history"
import { autoCompact, runCompaction, type CompactionHost, type CompactionObservation } from "./compaction"
import { ContextBudget } from "./context-budget"
import { completedRound, ScriptedProvider } from "./test-support"

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xal-compaction-offload-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function historyWithOutputs(): ConversationItem[] {
  return [
    { type: "user_message", text: "Preserve my exact requirements", images: [] },
    { type: "assistant_message", text: "The current decision must stay verbatim" },
    ...Array.from({ length: 13 }, (_, index): ConversationItem[] => [
      { type: "tool_call", callId: `call-${index}`, name: "read", args: { file_path: `${index}.ts` } },
      {
        type: "tool_result",
        callId: `call-${index}`,
        output: index === 0 ? "old source\n".repeat(3000) : "recent source",
      },
    ]).flat(),
  ]
}

function hostFor(initial: HistoryItem[]): CompactionHost & { observations: CompactionObservation[] } {
  let history = initial
  const budget = new ContextBudget()
  const observations: CompactionObservation[] = []
  const request = (items: HistoryItem[]): StreamRequest => ({
    model: "test-model",
    instructions: "Continue coding",
    tools: [],
    cacheKey: "offload-test",
    input: activeHistory(items),
    toolChoice: "auto",
    sessionId: "offload-test",
  })
  return {
    kind: "primary",
    sessionId: () => "offload-test",
    profileId: () => "test-profile",
    history: () => history,
    outputDirectory: () => directory,
    contextTokens: () => budget.currentTokens,
    buildRequest: () => request(history),
    buildRequestWithHistory: request,
    admitRequest: (provider, candidate) => budget.admit(provider.id, "test-profile", candidate),
    onRequestStarted() {},
    observeCompaction: (observation) => observations.push(observation),
    replaceHistory: (item) => {
      history = [item]
      budget.reset(history)
    },
    setState() {},
    emit() {},
    observations,
  }
}

test("automatically offloads without inference and round-trips the exact active conversation and archive", async () => {
  const original = historyWithOutputs()
  const host = hostFor(original)
  const provider = new ScriptedProvider([], 20_000, 2_000)
  const request = await autoCompact(host, new AbortController().signal, provider, "test-model", undefined)
  expect(provider.requests).toHaveLength(0)
  expect(request.input.slice(0, 3)).toEqual(original.slice(0, 3))
  expect(request.input.slice(4)).toEqual(original.slice(4))
  expect(request.input).toHaveLength(original.length)
  const archived = request.input[3]
  if (archived?.type !== "tool_result") throw new Error("missing archived result")
  const path = /Archived tool result: (.+)/.exec(archived.output)?.[1]
  if (!path) throw new Error("missing archive")
  const old = original[3]
  if (old?.type !== "tool_result") throw new Error("missing original result")
  expect(await readFile(path, "utf8")).toBe(old.output)
  const checkpoint = host.history()[0]
  if (!checkpoint) throw new Error("missing checkpoint")
  expect(checkpoint).toMatchObject({ type: "compaction", strategy: "tool_outputs_v1", replaced: 1 })
  const record = parseRecord(JSON.stringify({ type: "item", item: checkpoint }))
  if (record.type !== "item") throw new Error("missing checkpoint record")
  expect(record.item).toEqual(checkpoint)
  expect(activeHistory([record.item])).toEqual(request.input)
  expect(host.observations).toMatchObject([{ strategy: "tool_outputs_v1", outcome: "completed", removedTypes: [] }])
})

test("manual compaction and insufficient automatic savings summarize the unchanged original history", async () => {
  for (const scenario of ["manual", "reduction", "limit"]) {
    const archivesBefore = (await readdir(directory)).length
    const original = historyWithOutputs()
    if (scenario === "reduction") original.unshift({ type: "assistant_message", text: "decision".repeat(20_000) })
    const host = hostFor(original)
    const provider = new ScriptedProvider(
      [completedRound("Summarized state")],
      200_000,
      scenario === "limit" ? 1 : undefined,
    )
    expect(
      await runCompaction(
        host,
        new AbortController().signal,
        provider,
        "test-model",
        scenario === "manual" ? "manual" : "auto",
      ),
    ).toBe(true)
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.toolChoice).toBe("none")
    expect(provider.requests[0]?.input.slice(0, -1)).toEqual(original)
    expect(host.history()[0]).toMatchObject({ type: "compaction", strategy: "user_messages_v1" })
    expect(await readdir(directory)).toHaveLength(archivesBefore + 1)
  }
})

test("archive failures and cancellation before committing leave active history untouched", async () => {
  const original = historyWithOutputs()
  const host = hostFor(original)
  const provider = new ScriptedProvider([])
  await expect(
    runCompaction(
      { ...host, outputDirectory: () => import.meta.path },
      new AbortController().signal,
      provider,
      "test-model",
      "auto",
    ),
  ).rejects.toThrow()
  expect(host.history()).toBe(original)
  expect(host.observations.at(-1)).toMatchObject({ strategy: "tool_outputs_v1", outcome: "failed" })

  const controller = new AbortController()
  await expect(
    runCompaction(
      {
        ...host,
        buildRequestWithHistory: (...args) => {
          controller.abort(new Error("cancel before committing"))
          return host.buildRequestWithHistory(...args)
        },
      },
      controller.signal,
      provider,
      "test-model",
      "auto",
    ),
  ).rejects.toThrow("cancel before committing")
  expect(host.history()).toBe(original)
  expect(host.observations.at(-1)).toMatchObject({ strategy: "tool_outputs_v1", outcome: "interrupted" })
  expect(provider.requests).toHaveLength(0)
  expect(await readdir(directory)).toEqual([])
})

test("removes every pending archive when a later save fails or is interrupted", async () => {
  for (const scenario of ["failure", "interrupted"]) {
    const original = historyWithOutputs()
    original.unshift(
      { type: "tool_call", callId: "extra", name: "grep", args: {} },
      { type: "tool_result", callId: "extra", output: "older matches\n".repeat(1000) },
    )
    const host = hostFor(original)
    const provider = new ScriptedProvider([])
    const controller = new AbortController()
    const save = output.saveToolOutput
    let saved = 0
    const archive = spyOn(output, "saveToolOutput").mockImplementation(async (...args) => {
      const path = await save(...args)
      saved += 1
      if (saved === 2) {
        if (scenario === "failure") throw new Error("later archive failed")
        controller.abort(new Error("archive interrupted"))
      }
      return path
    })
    try {
      await expect(runCompaction(host, controller.signal, provider, "test-model", "auto")).rejects.toThrow(
        scenario === "failure" ? "later archive failed" : "archive interrupted",
      )
      expect(saved).toBe(2)
      expect(host.history()).toBe(original)
      expect(provider.requests).toHaveLength(0)
      expect(await readdir(directory)).toEqual([])
    } finally {
      archive.mockRestore()
    }
  }
})
