import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearHooks, registerHook } from "../../hooks/registry"
import type { Hook } from "../../hooks/types"
import { writeTool } from "../../plugins/files/write"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { AgentEvent } from "../events"
import type { SessionKind } from "../types"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("hook-deadlines-")
})

afterEach(() => clearHooks())

afterAll(async () => {
  await harness.cleanup()
})

test.each(["primary", "subagent"] satisfies SessionKind[])(
  "a stalled completion hook fails the %s turn without repairing or reporting success",
  async (kind) => {
    const events: AgentEvent[] = []
    registerHook("test", 0, 0, {
      name: "gate",
      timeoutMs: 10,
      beforeComplete: () => new Promise<undefined>(() => {}),
      turnEnd() {
        throw new Error("must not report success")
      },
    } satisfies Hook)
    const provider = new ScriptedProvider([completedRound("Proposed completion")])
    const session = harness.createSession(provider, { kind })
    const outcome = await runSettledTurn(session, { text: "Finish", images: [] }, (event) => events.push(event))

    expect(outcome).toMatchObject({
      status: "failed",
      error: "hook test/gate failed during before_complete: timed out after 10ms",
    })
    expect(provider.requests).toHaveLength(1)
    expect(session.currentState).toBe("idle")
    expect(events.some((event) => event.type === "turn_ended")).toBe(false)
    expect(events.filter((event) => event.type === "hook_finished")).toMatchObject([
      { hook: "test/gate", event: "before_complete", action: "failed" },
    ])
  },
)

test.each(["beforeTool", "afterTool"] as const)(
  "%s timeout preserves whether the file mutation actually ran",
  async (handler) => {
    const cwd = await mkdtemp(join(tmpdir(), "hook-deadline-workspace-"))
    const path = join(cwd, "result.txt")
    const events: AgentEvent[] = []
    registerTool(writeTool)
    try {
      registerHook("test", 0, 0, {
        name: "waiting",
        timeoutMs: 10,
        [handler]: () => new Promise<undefined>(() => {}),
      } satisfies Hook)
      const provider = new ScriptedProvider([
        toolRound("write", "write", { file_path: "result.txt", content: "Written\n" }),
        completedRound("The tool reported a hook failure; inspect the file before retrying."),
      ])
      const session = harness.createSession(provider, { cwd })
      session.setMode("yolo")
      const outcome = await runSettledTurn(session, { text: "Write the file", images: [] }, (event) =>
        events.push(event),
      )

      if (handler === "beforeTool") {
        expect(outcome).toMatchObject({
          status: "failed",
          error: "hook test/waiting failed during before_tool: timed out after 10ms",
        })
        expect(await Bun.file(path).exists()).toBe(false)
        expect(provider.requests).toHaveLength(1)
        expect(events.some((event) => event.type === "tool_started" || event.type === "turn_ended")).toBe(false)
        return
      }
      expect(outcome.status).toBe("completed")
      expect(await readFile(path, "utf8")).toBe("Written\n")
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]?.input).toContainEqual({
        type: "tool_result",
        callId: "write",
        output:
          "Tool failed: hook test/waiting failed during after_tool: timed out after 10ms. The tool may have changed state; inspect it before retrying.",
      })
      expect(events.filter((event) => event.type === "hook_finished")).toMatchObject([
        { hook: "test/waiting", event: "after_tool", action: "failed" },
      ])
    } finally {
      unregisterTool(writeTool)
      await rm(cwd, { recursive: true, force: true })
    }
  },
)
