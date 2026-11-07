import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resumeSession } from "../agent/session/compose"
import { AgentSession } from "../agent/session/session"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  type AgentSessionTestHarness,
} from "../agent/session/test-support"
import { createProfile } from "../config/credentials"
import { projectSessionsDir } from "../config/paths"
import * as processTools from "../lib/process"
import { registerProvider } from "../providers/registry"
import { SessionWriter } from "../sessions/ownership"
import { SessionRecorder } from "../sessions/recorder"
import { findSession } from "../sessions/store"
import { registerTool, unregisterTool } from "../tools/registry"
import type { Tool } from "../tools/types"
import { takeOverBackgroundSession } from "./attach"
import { detachSession } from "./launch"
import { claimBgLease, readBgLease, readBgState, releaseBgLease, writeBgState } from "./state"

let harness: AgentSessionTestHarness
let cwd: string

beforeAll(async () => {
  harness = await setupAgentSessionTests("bg-ownership-")
  cwd = await mkdtemp(join(tmpdir(), "xal-bg-workspace-"))
})

afterAll(async () => {
  await harness.cleanup()
  await rm(cwd, { recursive: true, force: true })
})

async function create(provider = new ScriptedProvider([])): Promise<AgentSession> {
  registerProvider(provider)
  const profile = await createProfile(provider.id, provider.id, { type: "api_key", key: "test-only" })
  const session = new AgentSession({
    cwd,
    provider,
    profileId: profile.id,
    model: "test-model",
    persist: true,
    trackUndoPrompts: false,
  })
  session.setMode("yolo")
  return session
}

test("worker reservation and attach carry exclusive transcript ownership through both handoffs", async () => {
  const session = await create(new ScriptedProvider([completedRound("saved")]))
  const contender = await create()
  const workerId = crypto.randomUUID()
  const worker = new SessionRecorder(() => {})
  try {
    expect((await runSettledTurn(session, { text: "Save before handoff", images: [] })).status).toBe("completed")
    const summary = await findSession(session.id)
    if (!summary) throw new Error("missing saved session")
    await claimBgLease(session.id, workerId)
    expect(() => SessionWriter.acquire(summary.path)).toThrow("already open")
    await session.closePersistence()
    await expect(resumeSession(contender, summary)).rejects.toThrow("running in the background")
    worker.attach(SessionWriter.acquire(summary.path))
    await worker.eventAndWait({ type: "session_title_changed", title: "Worker wrote this" })
    expect(() => SessionWriter.acquire(summary.path)).toThrow("already open")
    await worker.close()
    await writeBgState({
      version: 1,
      appVersion: "test",
      sessionId: session.id,
      sessionPath: summary.path,
      cwd,
      log: "worker.log",
      pid: process.pid,
      workerId,
      startedAt: 1,
      updatedAt: 2,
      status: "handoff",
    })
    await releaseBgLease(session.id, workerId)
    const takeover = await takeOverBackgroundSession(session.id)
    try {
      expect(await readBgState(session.id)).toBeUndefined()
      expect(() => SessionWriter.acquire(summary.path)).toThrow("already open")
      await resumeSession(contender, takeover.summary, { writer: takeover.writer, deferGoalResume: true })
      takeover.writer.close()
      expect(() => SessionWriter.acquire(summary.path)).toThrow("already open")
      expect(contender.startEvent().title).toBe("Worker wrote this")
      expect(await readFile(summary.path, "utf8")).toContain("Worker wrote this")
    } finally {
      takeover.writer.close()
    }
  } finally {
    await worker.close()
    await session.close()
    await contender.close()
  }
})

test("failed detached-worker startup is reaped before the foreground reacquires and reloads its transcript", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const tool: Tool = {
    name: "handoff_probe",
    description: "Wait for handoff",
    parameters: { type: "object", properties: {} },
    title: () => "Wait",
    readOnly: () => true,
    async execute() {
      entered.resolve()
      await release.promise
      return { output: "settled" }
    },
  }
  registerTool(tool)
  const provider = new ScriptedProvider([
    round([
      { type: "item_done", item: { type: "tool_call", callId: "handoff", name: tool.name, args: {} } },
      { type: "done" },
    ]),
    completedRound("recovered"),
  ])
  const session = await create(provider)
  const spawning = spyOn(processTools, "selfCommand").mockReturnValue([process.execPath, "--eval", "process.exit(42)"])
  try {
    expect(session.send({ text: "Detach this", images: [] })).toBe(true)
    await entered.promise
    const detaching = detachSession(session)
    release.resolve()
    expect(await detaching).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("exited during startup"),
    })
    expect(spawning).toHaveBeenCalledTimes(1)
    expect(await readBgState(session.id)).toBeUndefined()
    expect(await readBgLease(session.id)).toBeUndefined()
    expect(() => SessionWriter.acquire(join(projectSessionsDir(cwd), `${session.id}.jsonl`))).toThrow("already open")
  } finally {
    release.resolve()
    spawning.mockRestore()
    await session.close()
    unregisterTool(tool)
  }
})
