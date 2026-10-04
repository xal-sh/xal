import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { backgroundSessionDir } from "../config/paths"
import {
  assertBgLease,
  backgroundStatePath,
  claimBgLease,
  clearBackgroundSessions,
  findBackgroundSession,
  listBackgroundSessions,
  readBgLease,
  readBgState,
  releaseBgLease,
  writeBgState,
  type BgState,
} from "./state"

async function withAgentHome(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-bg-test-`))
  const homeEnv = appEnvVar("HOME")
  const inherited = process.env[homeEnv]
  process.env[homeEnv] = directory
  try {
    await run()
  } finally {
    if (inherited === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inherited
    await rm(directory, { recursive: true, force: true })
  }
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

function state(sessionId: string, pid: number, overrides: Partial<BgState> = {}): BgState {
  return {
    version: 1,
    appVersion: appInfo.version,
    sessionId,
    sessionPath: `/sessions/${sessionId}.jsonl`,
    cwd: "/workspace",
    log: `/logs/${sessionId}.log`,
    pid,
    workerId: `worker-${sessionId}`,
    startedAt: 1,
    updatedAt: 1,
    status: "running",
    ...overrides,
  }
}

test("lets one worker hold a session lease and only its owner release it", async () => {
  await withAgentHome(async () => {
    await mkdir(backgroundSessionDir("session-a"), { recursive: true })

    await claimBgLease("session-a", "worker-1")

    expect(await readBgLease("session-a")).toMatchObject({ sessionId: "session-a", workerId: "worker-1" })
    await expect(claimBgLease("session-a", "worker-2")).rejects.toThrow()
    await assertBgLease("session-a", "worker-1")
    await expect(assertBgLease("session-a", "worker-2")).rejects.toThrow("worker-2 no longer owns session-a")
    await expect(releaseBgLease("session-a", "worker-2")).rejects.toThrow("worker-2 no longer owns session-a")

    await releaseBgLease("session-a", "worker-1")

    expect(await readBgLease("session-a")).toBeUndefined()
    await expect(assertBgLease("session-a", "worker-1")).rejects.toThrow("no longer owns session-a")
  })
})

test("rejects a lease recorded for a different session", async () => {
  await withAgentHome(async () => {
    await mkdir(backgroundSessionDir("session-a"), { recursive: true })
    await claimBgLease("session-b", "worker-1")
    await writeFile(
      join(backgroundSessionDir("session-a"), "lease.json"),
      JSON.stringify({ version: 1, sessionId: "session-b", workerId: "worker-1", createdAt: 1 }),
    )

    await expect(readBgLease("session-a")).rejects.toThrow("malformed lease")
  })
})

test("refuses to read background state it cannot understand", async () => {
  await withAgentHome(async () => {
    await mkdir(backgroundSessionDir("session-a"), { recursive: true })
    await writeFile(backgroundStatePath("session-a"), JSON.stringify({ version: 1, sessionId: "session-a" }))

    await expect(readBgState("session-a")).rejects.toThrow("unsupported or malformed background state")
    await expect(listBackgroundSessions()).rejects.toThrow("unsupported or malformed background state")
  })
})

test("writes background state that reads back unchanged", async () => {
  await withAgentHome(async () => {
    const written = state("session-a", process.pid, { title: "fix login", activity: "editing", detail: "src/app.ts" })

    await writeBgState(written)

    expect(await readBgState("session-a")).toEqual(written)
  })
})

test("reports a running session whose worker vanished as died", async () => {
  await withAgentHome(async () => {
    await writeBgState(state("alive", process.pid, { updatedAt: 10 }))
    await writeBgState(state("gone", await deadPid(), { updatedAt: 30 }))
    await writeBgState(state("finished", await deadPid(), { updatedAt: 20, status: "done" }))

    const views = await listBackgroundSessions()

    expect(views.map((view) => [view.state.sessionId, view.effective])).toEqual([
      ["gone", "died"],
      ["finished", "done"],
      ["alive", "running"],
    ])
  })
})

test("resolves a session by unambiguous id prefix", async () => {
  await withAgentHome(async () => {
    await writeBgState(state("abc123", await deadPid()))
    await writeBgState(state("abc456", await deadPid()))
    await writeBgState(state("def789", await deadPid()))

    expect((await findBackgroundSession("def"))?.state.sessionId).toBe("def789")
    expect((await findBackgroundSession("abc123"))?.state.sessionId).toBe("abc123")
    expect(await findBackgroundSession("zzz")).toBeUndefined()
    await expect(findBackgroundSession("abc")).rejects.toThrow("prefix abc is ambiguous")
  })
})

test("clears only sessions whose worker is no longer running", async () => {
  await withAgentHome(async () => {
    await writeBgState(state("alive", process.pid))
    await writeBgState(state("gone", await deadPid()))

    await expect(clearBackgroundSessions("alive")).rejects.toThrow("is still running; stop it first")
    await expect(clearBackgroundSessions("missing")).rejects.toThrow("no background session matches missing")

    expect(await clearBackgroundSessions()).toEqual(["gone"])
    expect((await listBackgroundSessions()).map((view) => view.state.sessionId)).toEqual(["alive"])
  })
})

test("refuses a background session id that would escape its directory", () => {
  for (const id of ["..", ".", "", "../escape", "nested/id"]) {
    expect(() => backgroundSessionDir(id)).toThrow("invalid background session id")
  }
})
