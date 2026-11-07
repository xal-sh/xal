import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectSessionsDir } from "../../config/paths"
import { bashTool } from "../../plugins/shell/bash/tool"
import { SessionWriter } from "../../sessions/ownership"
import { parseRecord } from "../../sessions/records"
import { findSession, loadSession } from "../../sessions/store"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { AgentEvent } from "../events"
import { resumeSession } from "./compose"
import { AgentSession } from "./session"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("persistence-")
})

afterAll(async () => {
  await harness.cleanup()
})

async function fixture(run: (cwd: string, tool: Tool) => Promise<void>): Promise<void> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "xal-persistence-workspace-"))
  const tool: Tool = {
    name: "persistence_probe",
    description: "Write a test marker",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    title: () => "Write a marker",
    readOnly: () => false,
    async execute(args) {
      await fs.writeFile(join(cwd, String(args.name)), "written")
      return { output: "written" }
    },
  }
  registerTool(tool)
  registerTool(bashTool)
  try {
    await run(cwd, tool)
  } finally {
    unregisterTool(tool)
    unregisterTool(bashTool)
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

function create(cwd: string, provider: ScriptedProvider, persist = true): AgentSession {
  const session = new AgentSession({
    cwd,
    provider,
    persist,
    profileId: "test-profile",
    model: "test-model",
    trackUndoPrompts: false,
  })
  session.setMode("yolo")
  return session
}

for (const failedRecord of ["tool_call", "tool_result", "turn_ended"] as const) {
  test(`a failed ${failedRecord} write blocks later effects and completion until explicit recovery`, async () => {
    await fixture(async (cwd, tool) => {
      const provider = new ScriptedProvider([
        round([
          { type: "item_done", item: { type: "tool_call", callId: "first", name: tool.name, args: { name: "first" } } },
          {
            type: "item_done",
            item: { type: "tool_call", callId: "second", name: tool.name, args: { name: "second" } },
          },
          { type: "done" },
        ]),
        completedRound("done"),
      ])
      const session = create(cwd, provider)
      const events: AgentEvent[] = []
      const append = fs.appendFile
      let failures = 0
      const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
        if (typeof args[1] === "string") {
          const record = parseRecord(args[1])
          if (
            (record.type === "item" && record.item.type === failedRecord) ||
            (record.type === "event" && record.event.type === failedRecord)
          ) {
            failures += 1
            throw new Error("ENOSPC: injected transcript write failure")
          }
        }
        return append(...args)
      })
      try {
        const result = await runSettledTurn(session, { text: "Write two markers", images: [] }, (event) =>
          events.push(event),
        )
        expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("ENOSPC") })
        expect(failures).toBe(1)
        expect(await Bun.file(join(cwd, "first")).exists()).toBe(failedRecord !== "tool_call")
        expect(await Bun.file(join(cwd, "second")).exists()).toBe(failedRecord === "turn_ended")
        expect(events.filter((event) => event.type === "error")).toHaveLength(1)
        expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1)
        expect(events.some((event) => event.type === "turn_ended" || event.type === "turn_interrupted")).toBe(false)
        write.mockRestore()
        expect(session.send({ text: "Try again", images: [] })).toBe(false)
        expect(session.continueTurn()).toBe(false)
        expect(session.retryPendingTools()).toBe(false)
        await expect(session.flushPersistence()).rejects.toThrow("ENOSPC")
        await expect(session.close()).rejects.toThrow("ENOSPC")
        const writer = SessionWriter.acquire(join(projectSessionsDir(cwd), `${session.id}.jsonl`))
        writer.close()
      } finally {
        write.mockRestore()
        await session.close()
      }
    })
  })
}

test("waits for call acknowledgement and records the terminal event before publishing success", async () => {
  await fixture(async (cwd, tool) => {
    const provider = new ScriptedProvider([
      round([
        { type: "item_done", item: { type: "tool_call", callId: "first", name: tool.name, args: { name: "first" } } },
        { type: "done" },
      ]),
      completedRound("done"),
    ])
    const session = create(cwd, provider)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const append = fs.appendFile
    const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (typeof args[1] === "string" && args[1].includes('"type":"tool_call"')) {
        entered.resolve()
        await release.promise
      }
      return append(...args)
    })
    try {
      const running = runSettledTurn(session, { text: "Write a marker", images: [] })
      await entered.promise
      expect(await Bun.file(join(cwd, "first")).exists()).toBe(false)
      release.resolve()
      expect((await running).status).toBe("completed")
      const saved = await loadSession(join(projectSessionsDir(cwd), `${session.id}.jsonl`))
      expect(saved?.events.some((event) => event.type === "turn_ended")).toBe(true)
      expect(saved?.items.some((item) => item.type === "tool_result")).toBe(true)
    } finally {
      release.resolve()
      write.mockRestore()
      await session.close()
    }
  })
})

test("cancellation during intent acknowledgement preserves completed shared-tool results", async () => {
  await fixture(async (cwd, tool) => {
    tool.concurrency = () => "shared"
    const provider = new ScriptedProvider([
      round([
        ...Array.from({ length: 5 }, (_, index) => ({
          type: "item_done" as const,
          item: {
            type: "tool_call" as const,
            callId: `shared-${index}`,
            name: tool.name,
            args: { name: String(index) },
          },
        })),
        { type: "done" },
      ]),
    ])
    const session = create(cwd, provider)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const append = fs.appendFile
    const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (typeof args[1] === "string") {
        const record = parseRecord(args[1])
        if (record.type === "event" && record.event.type === "tool_started" && record.event.callId === "shared-4") {
          entered.resolve()
          await release.promise
        }
      }
      return append(...args)
    })
    try {
      const running = runSettledTurn(session, { text: "Write separate markers concurrently", images: [] })
      await entered.promise
      session.interrupt()
      release.resolve()
      expect((await running).status).toBe("interrupted")
      expect(await Bun.file(join(cwd, "4")).exists()).toBe(false)
      const saved = await loadSession(join(projectSessionsDir(cwd), `${session.id}.jsonl`))
      expect(saved?.items.filter((item) => item.type === "tool_result")).toEqual(
        Array.from({ length: 5 }, (_, index) => ({
          type: "tool_result",
          callId: `shared-${index}`,
          output: index === 4 ? "Interrupted by user before execution." : "written",
        })),
      )
      expect(provider.requests).toHaveLength(1)
    } finally {
      release.resolve()
      write.mockRestore()
      await session.close()
    }
  })
})

test.each(["tool_started", "direct_shell", "turn_ended"])(
  "direct shell fails closed on %s writes; nonpersisted sessions are unaffected",
  async (failedRecord) => {
    await fixture(async (cwd) => {
      const persistent = create(cwd, new ScriptedProvider([]))
      const ephemeral = create(cwd, new ScriptedProvider([]), false)
      const append = fs.appendFile
      const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
        if (typeof args[1] === "string" && args[1].includes(`"type":"${failedRecord}"`))
          throw new Error("ENOSPC: shell record")
        return append(...args)
      })
      try {
        expect(await runSettledTurn(persistent, { text: "!printf saved > marker", images: [] })).toMatchObject({
          status: "failed",
          error: expect.stringContaining("ENOSPC"),
        })
        expect(await Bun.file(join(cwd, "marker")).exists()).toBe(failedRecord !== "tool_started")
        expect((await runSettledTurn(ephemeral, { text: "!printf saved > marker", images: [] })).status).toBe(
          "completed",
        )
        expect(await fs.readFile(join(cwd, "marker"), "utf8")).toBe("saved")
        await expect(persistent.close()).rejects.toThrow("ENOSPC")
      } finally {
        write.mockRestore()
        await persistent.close()
        await ephemeral.close()
      }
    })
  },
)

test.each([false, true])("concurrent closes wait for pending writes and share their failure (%s)", async (fail) => {
  await fixture(async (cwd) => {
    const session = create(cwd, new ScriptedProvider([]))
    await session.flushPersistence()
    const path = join(projectSessionsDir(cwd), `${session.id}.jsonl`)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const append = fs.appendFile
    const failure = new Error("ENOSPC: close transcript")
    const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      if (fail) throw failure
      return append(...args)
    })
    let closing: Promise<PromiseSettledResult<void>[]> | undefined
    try {
      session.setTitle("Pending close")
      await entered.promise
      const first = session.closePersistence()
      let closed = false
      const second = session.closePersistence().finally(() => {
        closed = true
      })
      closing = Promise.allSettled([first, second])
      await Bun.sleep(0)
      expect(closed).toBe(false)
      expect(() => SessionWriter.acquire(path)).toThrow("already open")
      release.resolve()
      const results = await closing
      expect(results.map((result) => result.status)).toEqual(
        fail ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
      )
      for (const result of results) {
        if (result.status !== "rejected") continue
        expect(result.reason).toBe(session.persistenceError)
        expect(session.persistenceError?.cause).toBe(failure)
      }
      SessionWriter.acquire(path).close()
    } finally {
      release.resolve()
      await closing
      write.mockRestore()
      await session.close()
    }
  })
})

test("manual compaction preserves the original persistence failure instead of reporting interruption", async () => {
  await fixture(async (cwd) => {
    const provider = new ScriptedProvider([])
    const session = create(cwd, provider)
    await session.flushPersistence()
    const write = spyOn(fs, "appendFile").mockRejectedValue(new Error("ENOSPC: compaction transcript"))
    try {
      session.setTitle("Pending compaction")
      await expect(session.compact()).rejects.toThrow("ENOSPC")
      expect(provider.requests).toHaveLength(0)
      expect(session.send({ text: "Try again", images: [] })).toBe(false)
      await expect(session.close()).rejects.toThrow("ENOSPC")
    } finally {
      write.mockRestore()
      await session.close()
    }
  })
})

test("shutdown drains an in-flight reset before releasing ownership and refuses new work", async () => {
  await fixture(async (cwd) => {
    const session = create(cwd, new ScriptedProvider([]))
    await session.flushPersistence()
    const path = join(projectSessionsDir(cwd), `${session.id}.jsonl`)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const append = fs.appendFile
    const write = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return append(...args)
    })
    try {
      session.setTitle("Pending write")
      await entered.promise
      const resetting = session.reset()
      const closing = session.close()
      expect(session.send({ text: "Too late", images: [] })).toBe(false)
      expect(() => SessionWriter.acquire(path)).toThrow("already open")
      release.resolve()
      expect(await resetting).toBe(true)
      await closing
      SessionWriter.acquire(path).close()
      expect(await session.reset()).toBe(false)
      expect((await loadSession(path))?.title).toBe("Pending write")
    } finally {
      release.resolve()
      write.mockRestore()
      await session.close()
    }
  })
})

test("resume refuses a live writer before repair, and fork and reset release only the old transcript", async () => {
  await fixture(async (cwd) => {
    const provider = new ScriptedProvider([completedRound("saved")])
    const session = create(cwd, provider)
    const contender = create(cwd, provider)
    try {
      expect((await runSettledTurn(session, { text: "Persist this", images: [] })).status).toBe("completed")
      const summary = await findSession(session.id)
      if (!summary) throw new Error("missing session")
      const original = await fs.readFile(summary.path, "utf8")
      await fs.appendFile(summary.path, '{"type":"item"')
      await expect(resumeSession(contender, summary)).rejects.toThrow("already open")
      expect(await fs.readFile(summary.path, "utf8")).toBe(`${original}{"type":"item"`)
      await fs.writeFile(summary.path, original)
      expect((await session.fork()).status).toBe("forked")
      SessionWriter.acquire(summary.path).close()
      const forkPath = join(projectSessionsDir(cwd), `${session.id}.jsonl`)
      expect(() => SessionWriter.acquire(forkPath)).toThrow("already open")
      expect(await session.reset()).toBe(true)
      SessionWriter.acquire(forkPath).close()
      session.setMode("normal")
      await session.flushPersistence()
      const resetPath = join(projectSessionsDir(cwd), `${session.id}.jsonl`)
      expect(() => SessionWriter.acquire(resetPath)).toThrow("already open")
    } finally {
      await session.close()
      await contender.close()
    }
  })
})
