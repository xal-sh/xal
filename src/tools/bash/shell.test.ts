import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getJob, stopJob, suppressDelivery, waitForProcessOutput } from "../../background/jobs"
import { disposeShellSession, executeShellCommand } from "./shell"
import { bashTool } from "./tool"

const sessions = new Set<string>()

async function run(sessionId: string, command: string, cwd: string): Promise<string> {
  sessions.add(sessionId)
  let output = ""
  const execution = executeShellCommand(sessionId, command, cwd, undefined, (text) => {
    output += text
  })
  const code = await execution.done
  if (code !== 0) throw new Error(`command exited with ${code}: ${command}`)
  return output.trim()
}

afterEach(() => {
  for (const sessionId of sessions) disposeShellSession(sessionId)
  sessions.clear()
})

test("keeps persistent shell state inside its owning session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tack-shell-session-test-"))
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

test("runs owner-scoped managed background Bash for task agents with a durable log", async () => {
  const sessionId = crypto.randomUUID()
  const directory = await mkdtemp(join(tmpdir(), "tack-shell-bg-test-"))
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
    expect(job.history).toContain("durable-marker")

    await stopJob(job)
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
