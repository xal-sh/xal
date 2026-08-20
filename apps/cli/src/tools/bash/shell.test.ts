import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { getJob, stopJob, suppressDelivery, waitForProcessOutput } from "../../background/jobs"
import { REDACTION_MARKER, replaceSecretValues } from "../../secrets/redactor"
import { spawnCommand } from "./process"
import { disposeShellSession, executeShellCommand } from "./shell"
import { bashTool } from "./tool"

const sessions = new Set<string>()

function capture(sessionId: string, command: string, cwd: string) {
  sessions.add(sessionId)
  let output = ""
  const execution = executeShellCommand(sessionId, command, cwd, undefined, (text) => {
    output += text
  })
  return { execution, result: execution.done.then((termination) => ({ output, termination })) }
}

async function run(sessionId: string, command: string, cwd: string): Promise<string> {
  const captured = capture(sessionId, command, cwd)
  const { output, termination } = await captured.result
  if (termination.status !== "exited" || termination.exitCode !== 0) {
    throw new Error(`command failed with ${JSON.stringify(termination)}: ${command}`)
  }
  return output.trim()
}

afterEach(() => {
  for (const sessionId of sessions) disposeShellSession(sessionId)
  sessions.clear()
})

test("keeps persistent shell state inside its owning session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), `${appInfo.name}-shell-session-test-`))
  const nested = join(workspace, "nested")
  await mkdir(nested)
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()

  try {
    await run(first, "cd nested", workspace)

    expect(await run(first, "pwd", workspace)).toBe(nested)
    expect(await run(second, "pwd", workspace)).toBe(workspace)
  } finally {
    disposeShellSession(first)
    disposeShellSession(second)
    await rm(workspace, { recursive: true, force: true })
  }
})

test("uses isolated fallback for concurrency and restarts dead or disposed shells", async () => {
  const sessionId = crypto.randomUUID()
  const cwd = process.cwd()
  await run(sessionId, "export XAL_NATIVE_SHELL_STATE=persisted", cwd)

  const persistent = capture(sessionId, "sleep 0.1; printf first", cwd)
  const isolated = capture(sessionId, 'printf "%s" "${XAL_NATIVE_SHELL_STATE-unset}"', cwd)
  expect((await isolated.result).output).toBe("unset")
  expect((await persistent.result).output).toBe("first")
  expect(await run(sessionId, 'printf "%s" "$XAL_NATIVE_SHELL_STATE"', cwd)).toBe("persisted")

  const killed = capture(sessionId, "kill -KILL $$", cwd)
  expect((await killed.result).termination.status).toBe("signaled")
  expect(await run(sessionId, "printf recovered", cwd)).toBe("recovered")

  const disposed = capture(sessionId, "sleep 30", cwd)
  disposeShellSession(sessionId)
  expect((await disposed.result).termination.status).toBe("signaled")
  expect(await run(sessionId, "printf restarted", cwd)).toBe("restarted")
})

test("preserves merged output ordering and non-zero status", async () => {
  const captured = capture(crypto.randomUUID(), "printf one; printf two >&2; printf three; exit 7", process.cwd())
  const result = await captured.result
  expect(result.output).toBe("onetwothree")
  expect(result.termination).toEqual({ status: "exited", exitCode: 7 })
})

test("applies native timeout and drains output beyond channel capacity without loss", async () => {
  const sessionId = crypto.randomUUID()
  sessions.add(sessionId)
  const timed = executeShellCommand(sessionId, "sleep 30", process.cwd(), undefined, () => {})
  timed.setTimeout(50)
  expect((await timed.done).status).toBe("signaled")
  expect(timed.timedOut()).toBe(true)

  const commandProcess = spawnCommand(["/bin/sh", "-c", "yes x | head -c 1000000"], { ...process.env }, process.cwd())
  let bytes = 0
  commandProcess.onOutput((chunk) => {
    bytes += chunk.length
  })
  expect(await commandProcess.done).toEqual({ status: "exited", exitCode: 0 })
  expect(bytes).toBe(1_000_000)
})

test("redacts cross-drain secrets and generations added while Bash is running", async () => {
  const sessionId = crypto.randomUUID()
  sessions.add(sessionId)
  const source = `shell-test-${sessionId}`
  replaceSecretValues(source, ["cross-secret"])
  let updates = ""
  try {
    const result = bashTool.execute(
      { command: "printf cross-; sleep 0.05; printf secret; sleep 0.1; printf dynamic-secret" },
      {
        cwd: process.cwd(),
        sessionId,
        sessionKind: "primary",
        directory: process.cwd(),
        signal: new AbortController().signal,
        update(text) {
          updates += text
        },
      },
    )
    await Bun.sleep(80)
    replaceSecretValues(source, ["cross-secret", "dynamic-secret"])
    const completed = await result
    expect(completed.output).toContain(REDACTION_MARKER)
    expect(completed.output).not.toContain("cross-secret")
    expect(completed.output).not.toContain("dynamic-secret")
    expect(updates).not.toContain("cross-secret")
    expect(updates).not.toContain("dynamic-secret")
  } finally {
    replaceSecretValues(source, [])
  }
})

test("runs owner-scoped managed background Bash for task agents with a durable log", async () => {
  const sessionId = crypto.randomUUID()
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-shell-bg-test-`))
  try {
    const result = await bashTool.execute(
      { command: "echo durable-marker && sleep 30", background: true },
      {
        cwd: process.cwd(),
        sessionId,
        sessionKind: "subagent",
        directory,
        signal: new AbortController().signal,
        update() {},
      },
    )
    const id = /background job ([\w-]+)/.exec(result.output)?.[1]
    if (!id) throw new Error(`background job id missing from: ${result.output}`)
    const job = getJob(id)
    if (!job || job.kind !== "process") throw new Error("background job was not registered")

    expect(job.ownerId).toBe(sessionId)
    await waitForProcessOutput(job, 5_000)
    expect(job.history.text()).toContain("durable-marker")

    await stopJob(job, "user")
    await job.completion
    suppressDelivery(job)

    expect(job.done).toBe(true)
    expect(job.termination?.status).toBe("signaled")
    if (job.record?.status !== "saved") throw new Error("background job log was not saved")
    expect(await readFile(job.record.path, "utf8")).toContain("durable-marker")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
