import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { getJob, reapOwnerJobs, stopJob, suppressDelivery, waitForProcessOutput } from "../../background/jobs"
import { requestBackground } from "../../background/promotion"
import { listBackgroundTasks, removeBackgroundTask } from "../../background/registry"
import { createNativeProcess } from "../../native"
import { REDACTION_MARKER, replaceSecretValues } from "../../secrets/redactor"
import { spawnCommand } from "./process"
import { sandboxAvailable } from "./sandbox"
import { disposeShellSession, executeShellCommand } from "./shell"
import { bashTool } from "./bash/tool"

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

test("shares only read-sandboxed foreground commands", () => {
  const ctx = { cwd: "/workspace" }
  expect(bashTool.concurrency?.({ command: "ls", sandbox: "read" }, ctx)).toBe(
    sandboxAvailable() ? "shared" : "exclusive",
  )
  expect(bashTool.concurrency?.({ command: "ls", sandbox: "read", background: true }, ctx)).toBe("exclusive")
  expect(bashTool.concurrency?.({ command: "ls", sandbox: "workspace" }, ctx)).toBe("exclusive")
  expect(bashTool.concurrency?.({ command: "ls" }, ctx)).toBe("exclusive")
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
  await run(sessionId, "export XAL_TIMEOUT_STATE=preserved; trap 'printf original-trap' INT", process.cwd())
  const originalTrap = await run(sessionId, "trap", process.cwd())
  let timedOutput = ""
  const timed = executeShellCommand(sessionId, "sleep 30; printf missed", process.cwd(), undefined, (text) => {
    timedOutput += text
  })
  timed.setTimeout(50)
  expect((await timed.done).status).toBe("exited")
  expect(timed.timedOut()).toBe(true)
  expect(timedOutput).toBe("")
  expect(await run(sessionId, 'printf "%s" "$XAL_TIMEOUT_STATE"', process.cwd())).toBe("preserved")
  expect(await run(sessionId, "trap", process.cwd())).toBe(originalTrap)

  const commandProcess = spawnCommand(["/bin/sh", "-c", "yes x | head -c 1000000"], { ...process.env }, process.cwd())
  let bytes = 0
  commandProcess.onOutput((chunk) => {
    bytes += chunk.length
  })
  expect(await commandProcess.done).toEqual({ status: "exited", exitCode: 0 })
  expect(bytes).toBe(1_000_000)

  const unobserved = spawnCommand(["/bin/sh", "-c", "yes x | head -c 1000000"], { ...process.env }, process.cwd())
  expect(await unobserved.done).toEqual({ status: "exited", exitCode: 0 })

  const native = createNativeProcess({
    launch: ["/bin/sh", "-c", "yes x | head -c 1000000"],
    cwd: process.cwd(),
    environment: [],
    stdin: false,
  })
  expect(await native.wait()).toMatchObject({ status: "exited", exitCode: 0 })
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

test.each([undefined, false])("foreground Bash with background=%s never registers a job", async (background) => {
  const sessionId = crypto.randomUUID()
  sessions.add(sessionId)
  const tasks = () => listBackgroundTasks().filter((task) => task.ownerId === sessionId)
  let output = ""
  const result = await bashTool.execute(
    { command: "printf foreground", ...(background === undefined ? {} : { background }) },
    {
      cwd: process.cwd(),
      sessionId,
      sessionKind: "primary",
      directory: process.cwd(),
      signal: new AbortController().signal,
      update(text) {
        output += text
        expect(tasks()).toHaveLength(0)
      },
    },
  )
  expect(output).toBe("foreground")
  expect(result.execution).toEqual({ status: "exited", exitCode: 0 })
  expect(result.output).toBe("foreground\n(exit code 0)")
  expect(tasks()).toHaveLength(0)
})

test("foreground Bash becomes a shell job only when promoted and lets other commands run", async () => {
  const sessionId = crypto.randomUUID()
  sessions.add(sessionId)
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-shell-promotion-test-`))
  const ctx = {
    cwd: process.cwd(),
    sessionId,
    sessionKind: "primary" as const,
    directory,
    signal: new AbortController().signal,
    update() {},
  }
  const tasks = () => listBackgroundTasks().filter((task) => task.ownerId === sessionId)
  try {
    const execution = bashTool.execute({ command: "echo promoted; sleep 30" }, ctx)
    expect(tasks()).toHaveLength(0)
    expect(requestBackground(sessionId)).toBe(true)
    const result = await execution
    const task = tasks()[0]
    if (!task) throw new Error("promoted command was not registered")
    expect(result.output).toContain(`Moved to background job ${task.id}`)
    expect(tasks()).toHaveLength(1)
    expect(task.state().running).toBe(true)
    expect((await bashTool.execute({ command: "printf independent" }, ctx)).output).toBe("independent\n(exit code 0)")
    expect(task.state().running).toBe(true)
    const job = getJob(task.id)
    if (!job || job.kind !== "process") throw new Error("promoted process job missing")
    await stopJob(job, "user")
    await job.completion
    expect(job.history.text()).toContain("promoted")
  } finally {
    await reapOwnerJobs(sessionId, 2_000)
    for (const task of tasks()) removeBackgroundTask(task.id)
    await rm(directory, { recursive: true, force: true })
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
