import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { projectSessionsDir } from "../../config/paths"
import { registerHook, removeHooks } from "../../hooks/registry"
import { setUserRules } from "../../permissions/rules"
import { codeModeTool } from "../../plugins/code-mode/tool"
import { readTool } from "../../plugins/files/read"
import { registerProjectInstructions } from "../../plugins/project-instructions/plugin"
import { SessionRecorder } from "../../sessions/recorder"
import { SessionWriter } from "../../sessions/ownership"
import { parseRecord } from "../../sessions/records"
import { loadSession } from "../../sessions/store"
import { registerTool, unregisterTool } from "../../tools/registry"
import { disposeToolSession, registerToolSessionDisposer } from "../../tools/session"
import type { SessionTool } from "../../tools/types"
import { registerPrompt } from "../prompt/registry"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSession,
  type AgentSessionConstructor,
  type AgentSessionTestHarness,
} from "./test-support"

let harness: AgentSessionTestHarness
let Session: AgentSessionConstructor
let root: string
const sessions: AgentSession[] = []

beforeAll(async () => {
  harness = await setupAgentSessionTests("instruction-continuity-")
  Session = (await import("./session")).AgentSession
  registerProjectInstructions({
    config: {},
    registerPrompt,
    registerHook: (hook) => registerHook("project-instructions", 0, 0, hook),
    registerToolSessionDisposer,
  })
  for (const tool of [readTool, codeModeTool]) registerTool(tool)
  setUserRules({ allow: ["read(*)", "code_mode(*)", "instruction_switch(*)"] })
})

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "xal-instruction-workspaces-")))
  for (const name of ["checkout", "worktree"]) {
    const cwd = join(root, name)
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, ".git"), "gitdir: ../git")
    await writeFile(join(cwd, "AGENTS.md"), `${name} root rules`)
    await writeFile(join(cwd, "src", "AGENTS.md"), `${name} nested rules`)
    await writeFile(join(cwd, "src", "file.ts"), "export {}\n")
  }
})

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.closePersistence()
    disposeToolSession(session.id)
    session.disposeAsyncDelivery()
  }
  await rm(root, { recursive: true, force: true })
})

afterAll(async () => {
  for (const tool of [readTool, codeModeTool]) unregisterTool(tool)
  removeHooks(0)
  setUserRules({})
  await harness.cleanup()
})

function create(provider: ScriptedProvider, workspace = "checkout", persist = false, task = false): AgentSession {
  const session = new Session({
    provider,
    profileId: "test-profile",
    model: "test-model",
    cwd: join(root, workspace),
    persist,
    kind: task ? "subagent" : "primary",
    trackUndoPrompts: false,
  })
  sessions.push(session)
  return session
}

test("prepares isolated primary and worktree task instructions, including Code Mode reads and workspace changes", async () => {
  const originalCwd = process.cwd()
  const primary = new ScriptedProvider([
    toolRound("read", "read", { file_path: "src/file.ts" }),
    completedRound("done"),
    completedRound("switched"),
  ])
  const task = new ScriptedProvider([
    toolRound("read", "code_mode", { code: 'emit(await callTool("read", {file_path: "src/file.ts"}));' }),
    completedRound("done"),
  ])
  const session = create(primary)
  const child = create(task, "worktree", false, true)
  const outcomes = await Promise.all([
    runSettledTurn(session, { text: "Inspect", images: [] }),
    runSettledTurn(child, { text: "Inspect", images: [] }),
  ])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["completed", "completed"])
  expect(primary.requests[0]?.instructions).toContain("checkout root rules")
  expect(primary.requests[0]?.instructions).not.toContain("nested rules")
  expect(primary.requests[1]?.instructions).toContain("checkout nested rules")
  expect(primary.requests[1]?.instructions).not.toContain("worktree root rules")
  expect(task.requests[0]?.instructions).toContain("worktree root rules")
  expect(task.requests[1]?.instructions).toContain("worktree nested rules")
  expect(task.requests[1]?.instructions).not.toContain("checkout root rules")
  session.changeWorkspace(join(root, "worktree"))
  expect((await runSettledTurn(session, { text: "Continue", images: [] })).status).toBe("completed")
  expect(primary.requests[2]?.instructions).toContain("worktree root rules")
  expect(primary.requests[2]?.instructions).not.toContain("checkout root rules")
  expect(primary.requests[2]?.instructions).not.toContain("nested rules")
  expect(process.cwd()).toBe(originalCwd)
})

test("discovers both nested paths after a workspace switch in the same tool batch", async () => {
  const cwd = join(root, "worktree")
  await mkdir(join(cwd, "lib"))
  await writeFile(join(cwd, "lib", "AGENTS.md"), "Worktree library rules")
  await writeFile(join(cwd, "lib", "file.ts"), "export {}\n")
  const switchTool: SessionTool = {
    name: "instruction_switch",
    description: "Switch the test workspace",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    sessionAware: true,
    title: () => "Switch workspace",
    readOnly: () => false,
    async execute(_args, ctx) {
      ctx.session.changeWorkspace(cwd)
      return { output: "switched" }
    },
  }
  registerTool(switchTool)
  try {
    const provider = new ScriptedProvider([
      round([
        { type: "item_done", item: { type: "tool_call", callId: "switch", name: switchTool.name, args: {} } },
        {
          type: "item_done",
          item: { type: "tool_call", callId: "src", name: "read", args: { file_path: "src/file.ts" } },
        },
        {
          type: "item_done",
          item: { type: "tool_call", callId: "lib", name: "read", args: { file_path: "lib/file.ts" } },
        },
        { type: "done" },
      ]),
      completedRound("done"),
    ])
    expect((await runSettledTurn(create(provider), { text: "Switch and inspect", images: [] })).status).toBe(
      "completed",
    )
    expect(provider.requests[1]?.instructions).toContain("worktree root rules")
    expect(provider.requests[1]?.instructions).toContain("worktree nested rules")
    expect(provider.requests[1]?.instructions).toContain("Worktree library rules")
    expect(provider.requests[1]?.instructions).not.toContain("checkout root rules")
  } finally {
    unregisterTool(switchTool)
  }
})

test("does not invoke the provider when cancelled during prompt state persistence", async () => {
  const provider = new ScriptedProvider([
    toolRound("read", "read", { file_path: "src/file.ts" }),
    completedRound("must not run"),
  ])
  const session = create(provider, "checkout", true)
  const save = SessionRecorder.prototype.promptState
  const persistence = spyOn(SessionRecorder.prototype, "promptState").mockImplementation(async function (
    this: SessionRecorder,
    id,
    state,
  ) {
    await save.call(this, id, state)
    if (Array.isArray(state.paths) && state.paths.length > 0) session.interrupt()
  })
  try {
    expect((await runSettledTurn(session, { text: "Inspect", images: [] })).status).toBe("interrupted")
    expect(provider.requests).toHaveLength(1)
  } finally {
    persistence.mockRestore()
  }
})

test("persists discovery through compaction, fork and resume, reloads contents, and resets it for new sessions", async () => {
  const provider = new ScriptedProvider([
    toolRound("read", "read", { file_path: "src/file.ts" }),
    completedRound("done"),
    completedRound("Compacted summary"),
    completedRound("forked"),
  ])
  const session = create(provider, "checkout", true)
  expect((await runSettledTurn(session, { text: "Inspect", images: [] })).status).toBe("completed")
  expect(await session.compact()).toBe("compacted")
  expect((await session.fork()).status).toBe("forked")
  expect((await runSettledTurn(session, { text: "Continue", images: [] })).status).toBe("completed")
  expect(provider.requests.at(-1)?.instructions).toContain("checkout nested rules")
  await session.flushPersistence()
  const cwd = join(root, "checkout")
  const path = join(projectSessionsDir(cwd), `${session.id}.jsonl`)
  const records = (await readFile(path, "utf8")).trim().split("\n").map(parseRecord)
  expect(records.filter((record) => record.type === "prompt_state")).toHaveLength(2)
  const loaded = await loadSession(path)
  if (!loaded) throw new Error("missing persisted session")
  expect(loaded.items.some((item) => item.type === "compaction")).toBe(true)
  expect(loaded.promptStates?.project_instructions).toEqual({ cwd, root: cwd, paths: [join("src", "AGENTS.md")] })
  disposeToolSession(session.id)
  session.disposeAsyncDelivery()
  await session.closePersistence()
  await writeFile(join(cwd, "src", "AGENTS.md"), "Updated nested rules")
  const resumedProvider = new ScriptedProvider([completedRound("resumed"), completedRound("new")])
  const resumed = create(resumedProvider, "worktree", true)
  expect(
    await resumed.resume({
      session: loaded,
      path,
      writer: SessionWriter.acquire(path),
      cwd,
      provider: resumedProvider,
      profileId: "test-profile",
      model: "test-model",
      mode: "normal",
      continueGoal: false,
    }),
  ).toBe(true)
  expect((await runSettledTurn(resumed, { text: "Continue", images: [] })).status).toBe("completed")
  expect(resumedProvider.requests[0]?.instructions).toContain("checkout root rules")
  expect(resumedProvider.requests[0]?.instructions).toContain("Updated nested rules")
  expect(resumedProvider.requests[0]?.instructions).not.toContain("worktree root rules")
  expect(await resumed.reset()).toBe(true)
  expect((await runSettledTurn(resumed, { text: "Start over", images: [] })).status).toBe("completed")
  expect(resumedProvider.requests[1]?.instructions).toContain("checkout root rules")
  expect(resumedProvider.requests[1]?.instructions).not.toContain("Updated nested rules")
})

test("does not request a model response when prompt state cannot be persisted", async () => {
  const directory = projectSessionsDir(join(root, "checkout"))
  await mkdir(dirname(directory), { recursive: true })
  await writeFile(directory, "not a directory")
  const provider = new ScriptedProvider([completedRound("must not run")])
  const session = create(provider, "checkout", true)
  const result = await runSettledTurn(session, { text: "Inspect", images: [] })
  expect(result.status).toBe("failed")
  expect(provider.requests).toHaveLength(0)
  await expect(session.flushPersistence()).rejects.toThrow("session not saved:")
  await expect(session.closePersistence()).rejects.toThrow("session not saved:")
  sessions.splice(sessions.indexOf(session), 1)
  disposeToolSession(session.id)
  session.disposeAsyncDelivery()
})

test("does not request a model response when project instructions cannot be loaded", async () => {
  const path = join(root, "checkout", "AGENTS.md")
  await rm(path)
  await mkdir(path)
  const provider = new ScriptedProvider([completedRound("must not run")])
  const result = await runSettledTurn(create(provider), { text: "Inspect", images: [] })
  expect(result.status).toBe("failed")
  expect(provider.requests).toHaveLength(0)
})
