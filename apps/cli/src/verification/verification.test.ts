import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerAgentClis } from "../agent/cli"
import type { AgentEvent } from "../agent/events"
import * as sessionCompose from "../agent/session/compose"
import { AgentSession } from "../agent/session/session"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "../agent/session/test-support"
import { requestBackground } from "../background/promotion"
import { resolveCli } from "../cli/registry"
import { getCommand } from "../commands/registry"
import type { CommandContext } from "../commands/types"
import { projectSessionsDir } from "../config/paths"
import { settings } from "../config/settings"
import * as gitCommand from "../git/command"
import { runGit } from "../git/command"
import { registerHook, removeHooks } from "../hooks/registry"
import type { Hook } from "../hooks/types"
import { contributeRules } from "../permissions/rules"
import { bashTool } from "../plugins/shell/bash/tool"
import { disposeShellSession, selectShell } from "../plugins/shell/shell"
import { SessionRecorder } from "../sessions/recorder"
import { loadSession } from "../sessions/store"
import { registerTool } from "../tools/registry"
import type { ToolExecutionContext } from "../tools/types"
import { WorkspaceUndo } from "../tools/undo"
import { registerVerification } from "./commands"
import { verificationSummary } from "./service"
import type { VerificationRecord } from "./types"
import { workspaceFingerprint } from "./workspace"

let harness: AgentSessionTestHarness
let cwd: string
const sessions: AgentSession[] = []
const originalVerification = settings().verification
const originalShell = process.env.SHELL

beforeAll(async () => {
  process.env.SHELL = "/bin/bash"
  expect(selectShell().executable).toBe("/bin/bash")
  harness = await setupAgentSessionTests("verification-test-")
  registerTool(bashTool)
  contributeRules({ ask: ["bash"] })
  registerVerification()
})

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "xal-verification-workspace-"))
  await runGit(cwd, ["init", "--quiet"])
  await writeFile(join(cwd, "source.txt"), "ok")
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n")
  await runGit(cwd, ["add", "source.txt", ".gitignore"])
  settings().verification = { checks: { test: 'test "$(cat source.txt)" = ok' }, gate: false }
})

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    disposeShellSession(session.id)
    session.disposeAsyncDelivery()
    await session.closePersistence()
  }
  settings().verification = originalVerification
  await rm(cwd, { recursive: true, force: true })
})

afterAll(async () => {
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
  await harness.cleanup()
})

function session(provider = new ScriptedProvider([]), persist = false): AgentSession {
  const created = new AgentSession({
    provider,
    profileId: "test-profile",
    model: "test-model",
    cwd,
    persist,
    trackUndoPrompts: false,
  })
  created.setMode("yolo")
  sessions.push(created)
  return created
}

async function runCheck(target: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const outcome = await runSettledTurn(
    target,
    { text: `!${settings().verification.checks.test}`, images: [] },
    (event) => events.push(event),
  )
  expect(outcome.status).toBe("completed")
  return events
}

test("records real passes and failures and refreshes evidence after edits", async () => {
  const target = session()
  expect(await target.verificationStatus()).toMatchObject([{ status: "not_run" }])
  const events = await runCheck(target)
  expect(events.filter((event) => event.type === "verification_recorded").map((event) => event.record.status)).toEqual([
    "started",
    "finished",
  ])
  expect(events.find((event) => event.type === "turn_ended")).toMatchObject({
    verification: [{ name: "test", status: "passed" }],
  })
  await writeFile(join(cwd, "ignored.txt"), "ignored change")
  expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
  await writeFile(join(cwd, "source.txt"), "broken")
  expect(await target.verificationStatus()).toMatchObject([{ status: "stale" }])
  await runCheck(target)
  expect(await target.verificationStatus()).toMatchObject([{ status: "failed", detail: "exit code 1" }])
  settings().verification.checks.test = "true"
  expect(await target.verificationStatus()).toMatchObject([{ status: "not_run" }])
})

test("fingerprints untracked files, executable bits, symlinks, and deletions across the repository", async () => {
  await mkdir(join(cwd, "nested"))
  const initial = await workspaceFingerprint(join(cwd, "nested"))
  expect(initial).toBe(await workspaceFingerprint(cwd))
  await writeFile(join(cwd, "untracked.txt"), "new")
  expect(await workspaceFingerprint(cwd)).not.toBe(initial)
  await rm(join(cwd, "untracked.txt"))
  expect(await workspaceFingerprint(cwd)).toBe(initial)
  await chmod(join(cwd, "source.txt"), 0o755)
  expect(await workspaceFingerprint(cwd)).not.toBe(initial)
  await chmod(join(cwd, "source.txt"), 0o644)
  expect(await workspaceFingerprint(cwd)).toBe(initial)
  await symlink("source.txt", join(cwd, "link"))
  const linked = await workspaceFingerprint(cwd)
  await rm(join(cwd, "link"))
  await symlink("ignored.txt", join(cwd, "link"))
  expect(await workspaceFingerprint(cwd)).not.toBe(linked)
  await rm(join(cwd, "link"))
  await rm(join(cwd, "source.txt"))
  expect(await workspaceFingerprint(cwd)).not.toBe(initial)
})

test("makes unsupported Git filename encoding unavailable instead of retaining a pass", async () => {
  const target = session()
  await runCheck(target)
  expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
  const run = gitCommand.runGitBytes
  const listing = spyOn(gitCommand, "runGitBytes").mockImplementation((cwd, args, signal) =>
    args[0] === "ls-files" ? Promise.resolve(Uint8Array.of(0xff, 0)) : run(cwd, args, signal),
  )
  try {
    await expect(workspaceFingerprint(cwd)).rejects.toThrow()
    expect(await target.verificationStatus()).toMatchObject([{ status: "stale" }])
    const events = await runCheck(target)
    expect(events.filter((event) => event.type === "verification_recorded").at(-1)).toMatchObject({
      record: { status: "finished", execution: { status: "exited", exitCode: 0 }, evidence: { status: "unavailable" } },
    })
  } finally {
    listing.mockRestore()
  }
})

test("uses a fresh shell without changing the ordinary persistent shell", async () => {
  settings().verification.checks.test = 'test -f source.txt && test -z "${XAL_VERIFICATION_LEAK+x}"'
  const target = session()
  await runSettledTurn(target, { text: "!cd /; export XAL_VERIFICATION_LEAK=old", images: [] })
  await runCheck(target)
  expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
  const ordinary = await runSettledTurn(target, { text: '!printf "%s" "$XAL_VERIFICATION_LEAK"', images: [] })
  expect(ordinary.response).toContain("old")
})

test("keeps successful executions stale when they mutate the workspace or evidence is unavailable", async () => {
  settings().verification.checks.test = "printf changed > source.txt"
  const target = session()
  await runCheck(target)
  expect(await target.verificationStatus()).toMatchObject([
    { status: "stale", detail: "exit code 0; workspace changed while the check ran" },
  ])
  await rm(join(cwd, ".git"), { recursive: true })
  settings().verification.checks.test = "true"
  const nonGit = session()
  const events = await runCheck(nonGit)
  expect(events.find((event) => event.type === "shell_finished")).toMatchObject({
    execution: { status: "exited", exitCode: 0 },
  })
  expect(await nonGit.verificationStatus()).toMatchObject([{ status: "stale" }])
})

test("does not infer passes from assistant text or denied calls and records model-issued checks", async () => {
  const provider = new ScriptedProvider([
    completedRound("All checks passed."),
    toolRound("check", "bash", { command: settings().verification.checks.test! }),
    completedRound("Finished."),
  ])
  const target = session(provider)
  await runSettledTurn(target, { text: "Check the code", images: [] })
  expect(await target.verificationStatus()).toMatchObject([{ status: "not_run" }])
  target.setMode("normal")
  const denied = await runSettledTurn(
    target,
    { text: `!${settings().verification.checks.test}`, images: [] },
    (event) => {
      if (event.type === "approval_requested") target.deny("user")
    },
  )
  expect(denied.status).toBe("completed")
  expect(await target.verificationStatus()).toMatchObject([{ status: "not_run" }])
  target.setMode("yolo")
  const result = await runSettledTurn(target, { text: "Run it", images: [] })
  expect(result).toMatchObject({ verification: [{ status: "passed" }] })
})

test("persists receipts through fork and resume, recomputes freshness, and clears on reset", async () => {
  const provider = new ScriptedProvider([])
  const target = session(provider, true)
  await runCheck(target)
  const originalId = target.id
  expect(await target.fork()).toMatchObject({ status: "forked" })
  expect(target.id).not.toBe(originalId)
  expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
  await target.flushPersistence()
  const path = join(projectSessionsDir(cwd), `${target.id}.jsonl`)
  const loaded = await loadSession(path)
  if (!loaded) throw new Error("missing persisted session")
  expect(loaded.events.filter((event) => event.type === "verification_recorded")).toHaveLength(2)
  await writeFile(join(cwd, "source.txt"), "edited after exit")
  const resumed = session(provider)
  expect(
    await resumed.resume({
      session: loaded,
      path,
      cwd,
      provider,
      profileId: "test-profile",
      model: "test-model",
      mode: "yolo",
      continueGoal: false,
    }),
  ).toBe(true)
  expect(await resumed.verificationStatus()).toMatchObject([{ status: "stale" }])
  expect(await resumed.reset()).toBe(true)
  expect(await resumed.verificationStatus()).toMatchObject([{ status: "not_run" }])
})

test("started reruns supersede old passes and configured checks cannot run in the background", async () => {
  settings().verification.checks.test = "printf ready; sleep 0.05"
  const records = new Map<string, VerificationRecord>()
  const controller = new AbortController()
  const ctx: ToolExecutionContext = {
    cwd,
    sessionId: crypto.randomUUID(),
    sessionKind: "primary",
    directory: cwd,
    signal: controller.signal,
    async recordVerification(record) {
      records.set(record.name, record)
      if (record.status === "started") {
        expect(await verificationSummary(cwd, records, false)).toMatchObject([
          { status: "failed", detail: "check started but no completion was recorded" },
        ])
      }
    },
    update() {
      expect(requestBackground(ctx.sessionId)).toBe(false)
    },
  }
  const args = { command: settings().verification.checks.test }
  await bashTool.execute(args, ctx)
  expect(await verificationSummary(cwd, records, false)).toMatchObject([{ status: "passed" }])
  expect(await verificationSummary(cwd, records, true)).toMatchObject([{ status: "stale" }])
  await expect(bashTool.execute({ ...args, background: true }, ctx)).rejects.toThrow("foreground")
  const rerun = await bashTool.execute(args, {
    ...ctx,
    update() {
      controller.abort()
    },
  })
  expect(rerun.execution?.status).toBe("interrupted")
  expect(records.get("test")).toMatchObject({ status: "finished", execution: { status: "interrupted" } })
  expect((await verificationSummary(cwd, records, false))?.[0]?.status).not.toBe("passed")
})

test.each([false, true])("awaits the rerun start write before execution (write fails: %s)", async (fail) => {
  settings().verification.checks.test = "printf ran >> ignored.txt"
  const target = session(new ScriptedProvider([]), true)
  await runCheck(target)
  await target.flushPersistence()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const record = SessionRecorder.prototype.eventAndWait
  const write = spyOn(SessionRecorder.prototype, "eventAndWait").mockImplementation(async function (
    this: SessionRecorder,
    event,
  ) {
    if (event.type === "verification_recorded" && event.record.status === "started") {
      entered.resolve()
      await release.promise
    }
    return record.call(this, event)
  })
  const rerun = runCheck(target)
  try {
    await entered.promise
    await Bun.sleep(25)
    expect(await readFile(join(cwd, "ignored.txt"), "utf8")).toBe("ran")
    expect(await target.verificationStatus()).toMatchObject([{ status: "failed" }])
    if (fail) release.reject(new Error("receipt write failed"))
    else release.resolve()
    const events = await rerun
    expect(await readFile(join(cwd, "ignored.txt"), "utf8")).toBe(fail ? "ran" : "ranran")
    if (fail) {
      expect(events.find((event) => event.type === "shell_finished")).toMatchObject({
        output: "Tool failed: receipt write failed",
      })
    }
    await target.flushPersistence()
    const loaded = await loadSession(join(projectSessionsDir(cwd), `${target.id}.jsonl`))
    expect(loaded?.events.filter((event) => event.type === "verification_recorded")).toHaveLength(fail ? 2 : 4)
  } finally {
    release.resolve()
    await rerun
    write.mockRestore()
  }
})

test("records the real shell exit after EXIT traps", async () => {
  settings().verification.checks.test = "trap 'printf exited; exit 7' EXIT; true"
  const target = session()
  const events = await runCheck(target)
  expect(events.find((event) => event.type === "shell_finished")).toMatchObject({
    output: "exited\n(exit code 7)",
    execution: { status: "exited", exitCode: 7 },
  })
  expect(await target.verificationStatus()).toMatchObject([{ status: "failed", detail: "exit code 7" }])
})

test("persists the actual outcome even if post-execution undo capture fails", async () => {
  settings().verification.checks.test = "printf changed > source.txt"
  const target = session(new ScriptedProvider([]), true)
  const capture = spyOn(WorkspaceUndo.prototype, "trackWorkspace").mockImplementation(async (_tool, operation) => {
    await operation()
    throw new Error("post-execution undo capture failed")
  })
  try {
    const events = await runCheck(target)
    expect(events.find((event) => event.type === "shell_finished")).toMatchObject({
      output: "Tool failed: post-execution undo capture failed",
    })
    await target.flushPersistence()
    const loaded = await loadSession(join(projectSessionsDir(cwd), `${target.id}.jsonl`))
    expect(loaded?.events.filter((event) => event.type === "verification_recorded").at(-1)).toMatchObject({
      record: { status: "finished", execution: { status: "exited", exitCode: 0 }, evidence: { status: "unavailable" } },
    })
    expect(await target.verificationStatus()).toMatchObject([
      { status: "stale", detail: "exit code 0; workspace changed while the check ran" },
    ])
  } finally {
    capture.mockRestore()
  }
})

test.each(["sleep 3", "sleep 3 & true"])("records timed-out checks as unsuccessful: %s", async (command) => {
  settings().verification.checks.test = command
  const provider = new ScriptedProvider([
    toolRound("timeout", "bash", { command, timeout: 1 }),
    completedRound("Stopped"),
  ])
  const events: AgentEvent[] = []
  const started = performance.now()
  const result = await runSettledTurn(session(provider), { text: "Run the check", images: [] }, (event) => {
    events.push(event)
  })
  expect(performance.now() - started).toBeLessThan(2500)
  expect(result).toMatchObject({ verification: [{ status: "failed", detail: "timed out after 1s" }] })
  expect(events.filter((event) => event.type === "verification_recorded").at(-1)).toMatchObject({
    record: { status: "finished", execution: { status: "timed_out", timeoutSeconds: 1 } },
  })
})

test("the checks command inspects evidence and runs the configured command", async () => {
  const target = session()
  const printed: string[] = []
  const ctx: CommandContext = {
    session: target,
    print: (text) => printed.push(text),
    busy() {},
    restore() {},
    async select() {
      return undefined
    },
    async ask() {
      return undefined
    },
    async askSecret() {
      return undefined
    },
  }
  const command = getCommand("checks")
  if (!command) throw new Error("missing checks command")
  await command.run([], ctx)
  expect(printed.join("\n")).toContain("not run")
  const idle = Promise.withResolvers<void>()
  const unsubscribe = target.subscribe((event) => {
    if (event.type === "state_changed" && event.state === "idle") idle.resolve()
  })
  try {
    await command.run(["test"], ctx)
    await idle.promise
    expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
  } finally {
    unsubscribe()
  }
})

test("gates once when a turn changes the workspace without passing checks", async () => {
  settings().verification.gate = true
  const unchanged = new ScriptedProvider([completedRound("Nothing to change.")])
  await runSettledTurn(session(unchanged), { text: "Explain the code", images: [] })
  expect(unchanged.requests).toHaveLength(1)

  const provider = new ScriptedProvider([
    toolRound("change", "bash", { command: "printf changed > source.txt" }),
    completedRound("Done."),
    completedRound("The test check cannot pass until source.txt is restored."),
  ])
  const outcome = await runSettledTurn(session(provider), { text: "Change the source", images: [] })

  expect(outcome.response).toBe("The test check cannot pass until source.txt is restored.")
  const correction = provider.requests[2]?.input.at(-1)
  if (!correction || correction.type !== "user_message") throw new Error("missing verification correction")
  expect(correction.text).toContain("You changed the workspace during this turn")
  expect(correction.text).toContain("test: not run")
})

test.each([false, true])("verifies hook-requested workspace repairs (structured=%s)", async (structured) => {
  settings().verification.gate = true
  registerHook("verification-test", 0, 0, {
    name: "handoff",
    beforeComplete(input) {
      if (input.continuationCount === 0) return { type: "block", reason: "Create HANDOFF.md before finishing" }
      return undefined
    },
  } satisfies Hook)
  try {
    const provider = new ScriptedProvider([
      structured ? toolRound("first", "submit_output", { done: true }) : completedRound("Done without a handoff."),
      toolRound("handoff", "bash", { command: "printf ready > HANDOFF.md" }),
      structured ? toolRound("second", "submit_output", { done: true }) : completedRound("Handoff is ready."),
      toolRound("check", "bash", { command: settings().verification.checks.test! }),
      structured ? toolRound("third", "submit_output", { done: true }) : completedRound("Handoff is verified."),
    ])
    const target = new AgentSession({
      provider,
      profileId: "test-profile",
      model: "test-model",
      cwd,
      persist: false,
      trackUndoPrompts: false,
      ...(structured
        ? { outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } }
        : {}),
    })
    target.setMode("yolo")
    sessions.push(target)

    const outcome = await runSettledTurn(target, { text: "Prepare a handoff", images: [] })

    expect(outcome.status).toBe("completed")
    expect(provider.requests).toHaveLength(5)
    const correction = provider.requests[3]?.input.at(-1)
    if (!correction || correction.type !== "user_message") throw new Error("missing verification correction")
    expect(correction.text).toContain("You changed the workspace during this turn")
    expect(correction.text).toContain("test: not run")
    expect(await target.verificationStatus()).toMatchObject([{ status: "passed" }])
    expect(await readFile(join(cwd, "HANDOFF.md"), "utf8")).toBe("ready")
    expect(outcome.response).toEqual(structured ? { done: true } : "Handoff is verified.")
  } finally {
    removeHooks(0)
  }
})

test("gates structured output before accepting it", async () => {
  settings().verification.gate = true
  const provider = new ScriptedProvider([
    toolRound("change", "bash", { command: "printf changed > source.txt" }),
    toolRound("first", "submit_output", { done: true }),
    toolRound("second", "submit_output", { done: false }),
  ])
  const target = new AgentSession({
    provider,
    profileId: "test-profile",
    model: "test-model",
    cwd,
    persist: false,
    trackUndoPrompts: false,
    outputSchema: {
      type: "object",
      properties: { done: { type: "boolean" } },
      required: ["done"],
      additionalProperties: false,
    },
  })
  target.setMode("yolo")
  sessions.push(target)

  const outcome = await runSettledTurn(target, { text: "Change the source", images: [] })

  expect(outcome).toMatchObject({ status: "completed", response: { done: false } })
  const correction = provider.requests[2]?.input.at(-1)
  if (!correction || correction.type !== "user_message") throw new Error("missing verification correction")
  expect(correction.text).toContain("You changed the workspace during this turn")
})

test.each([false, true])(
  "required verification bounds unverified completion (structured task=%s)",
  async (structured) => {
    settings().verification.gate = "required"
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }, (_, index) =>
        structured
          ? toolRound(`finish-${index}`, "submit_output", { attempt: index })
          : completedRound("All checks passed."),
      ),
    )
    const target = harness.createSession(provider, {
      cwd,
      kind: structured ? "subagent" : "primary",
      ...(structured
        ? { outputSchema: { type: "object", properties: { attempt: { type: "integer" } }, required: ["attempt"] } }
        : {}),
    })
    sessions.push(target)
    const events: AgentEvent[] = []
    const outcome = await runSettledTurn(target, { text: "Explain the code", images: [] }, (event) =>
      events.push(event),
    )

    expect(outcome.status).toBe("failed")
    if (outcome.status !== "failed") throw new Error("required verification did not fail")
    expect(outcome.error).toContain("Completion blocked by required verification after 3 continuations")
    expect(outcome.error).toContain("test: not run")
    expect(provider.requests).toHaveLength(4)
    expect(events.filter((event) => event.type === "turn_ended")).toHaveLength(0)
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1)
    for (const request of provider.requests.slice(1)) {
      expect(request.input.at(-1)).toMatchObject({
        type: "user_message",
        text: expect.stringContaining("Continue to follow the user's instructions and permission rules"),
      })
    }
    target.setMode("yolo")
    await runCheck(target)
    expect(await runSettledTurn(target, { text: "Finish with evidence", images: [] })).toMatchObject({
      status: "completed",
      response: structured ? { attempt: 4 } : "All checks passed.",
      verification: [{ status: "passed" }],
    })
    expect(provider.requests).toHaveLength(5)
  },
)

test("required verification repairs failures and hook-invalidated passes for every check", async () => {
  settings().verification.gate = "required"
  settings().verification.checks.lint = "test -f source.txt"
  registerHook("verification-test", 0, 0, {
    name: "handoff",
    async beforeComplete(input) {
      if (input.output === "Verified.") await writeFile(join(cwd, "HANDOFF.md"), "ready")
      return undefined
    },
  } satisfies Hook)
  try {
    const provider = new ScriptedProvider([
      completedRound("Done."),
      toolRound("break", "bash", { command: "printf broken > source.txt" }),
      toolRound("failing-test", "bash", { command: settings().verification.checks.test! }),
      toolRound("lint", "bash", { command: settings().verification.checks.lint! }),
      completedRound("The test cannot pass."),
      toolRound("repair", "bash", { command: "printf ok > source.txt" }),
      toolRound("test", "bash", { command: settings().verification.checks.test! }),
      toolRound("lint-again", "bash", { command: settings().verification.checks.lint! }),
      completedRound("Verified."),
      toolRound("test-handoff", "bash", { command: settings().verification.checks.test! }),
      toolRound("lint-handoff", "bash", { command: settings().verification.checks.lint! }),
      completedRound("Reverified."),
    ])
    const target = session(provider)
    const outcome = await runSettledTurn(target, { text: "Change and verify", images: [] })

    expect(outcome).toMatchObject({
      status: "completed",
      response: "Reverified.",
      verification: [
        { name: "test", status: "passed" },
        { name: "lint", status: "passed" },
      ],
    })
    expect(provider.requests).toHaveLength(12)
    expect(provider.requests[5]?.input.at(-1)).toMatchObject({ text: expect.stringContaining("test: failed") })
    expect(provider.requests[9]?.input.at(-1)).toMatchObject({ text: expect.stringContaining("test: stale") })
    expect(await readFile(join(cwd, "HANDOFF.md"), "utf8")).toBe("ready")
  } finally {
    removeHooks(0)
  }
})

test("required verification accepts fresh receipts and rejects turn-end mutations", async () => {
  settings().verification.gate = "required"
  const provider = new ScriptedProvider([completedRound("Verified."), completedRound("Still verified.")])
  const target = session(provider)
  await runCheck(target)
  expect(await runSettledTurn(target, { text: "Finish", images: [] })).toMatchObject({
    status: "completed",
    verification: [{ status: "passed" }],
  })
  let observed = 0
  registerHook("verification-test", 0, 0, {
    name: "late-change",
    async turnEnd() {
      observed += 1
      await writeFile(join(cwd, "source.txt"), "late change")
    },
  } satisfies Hook)
  try {
    const events: AgentEvent[] = []
    const outcome = await runSettledTurn(target, { text: "Finish again", images: [] }, (event) => events.push(event))
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining("required verification at turn end"),
    })
    expect(events.some((event) => event.type === "turn_ended")).toBe(false)
    expect(observed).toBe(1)
    expect(provider.requests).toHaveLength(2)
    expect(await target.verificationStatus()).toMatchObject([{ status: "stale" }])
  } finally {
    removeHooks(0)
  }
})

test("required verification fails closed when workspace evidence is unavailable", async () => {
  settings().verification.gate = "required"
  await rm(join(cwd, ".git"), { recursive: true })
  const provider = new ScriptedProvider(Array.from({ length: 4 }, () => completedRound("The command passed.")))
  const target = session(provider)
  const events = await runCheck(target)
  expect(events.find((event) => event.type === "shell_finished")).toMatchObject({
    execution: { status: "exited", exitCode: 0 },
  })

  const outcome = await runSettledTurn(target, { text: "Finish", images: [] })
  expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("test: stale") })
  expect(provider.requests).toHaveLength(4)
})

test.each([false, true])(
  "required verification preserves denied checks and cancellation (interrupt=%s)",
  async (interrupt) => {
    settings().verification.gate = "required"
    const provider = new ScriptedProvider([
      toolRound("check", "bash", { command: settings().verification.checks.test! }),
      ...Array.from({ length: 4 }, () => completedRound("The check was denied.")),
    ])
    const target = session(provider)
    target.setMode("normal")
    let approvals = 0
    const outcome = await runSettledTurn(target, { text: "Check and finish", images: [] }, (event) => {
      if (event.type !== "approval_requested") return
      approvals += 1
      if (interrupt) target.interrupt()
      else target.deny("user")
    })

    expect(outcome.status).toBe(interrupt ? "interrupted" : "failed")
    expect(approvals).toBe(1)
    expect(provider.requests).toHaveLength(interrupt ? 1 : 5)
    expect(await target.verificationStatus()).toMatchObject([{ status: "not_run" }])
  },
)

test("headless required-verification failure returns JSON failure and a nonzero exit code", async () => {
  settings().verification.gate = "required"
  const target = session(new ScriptedProvider(Array.from({ length: 4 }, () => completedRound("Done."))))
  const create = spyOn(sessionCompose, "createSession").mockResolvedValue({ session: target, model: "test-model" })
  const exitCode = process.exitCode
  const idle = Promise.withResolvers<void>()
  const unsubscribe = target.subscribe((event) => {
    if (event.type === "state_changed" && event.state === "idle") idle.resolve()
  })
  try {
    process.exitCode = 0
    registerAgentClis()
    const resolved = resolveCli(["run", "--format", "json", "Finish"])
    if (!resolved?.cli.run) throw new Error("missing run CLI")
    const printed: string[] = []
    await resolved.cli.run(resolved.args, {
      print: (text) => printed.push(text),
      error: (text) => printed.push(text),
      async ask() {
        throw new Error("headless run requested input")
      },
      async askSecret() {
        throw new Error("headless run requested a secret")
      },
    })
    await idle.promise
    expect(process.exitCode).toBe(1)
    const output: unknown = JSON.parse(printed.join("\n"))
    expect(output).toMatchObject({
      status: "failed",
      error: expect.stringContaining("required verification after 3 continuations"),
    })
  } finally {
    process.exitCode = exitCode ?? 0
    unsubscribe()
    create.mockRestore()
  }
})
