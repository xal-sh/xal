import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobLog } from "./log"

test("persists an oversized first event with a bounded queue behind it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-job-log-"))
  try {
    const log = createJobLog(directory, "large-event")
    const first = "🙂".repeat(1024 * 1024)
    log.append(first)
    log.append("last\n")
    await log.close()
    expect(log.capped()).toBe(false)
    expect(await readFile(log.path, "utf8")).toBe(`${first}last\n`)
    await log.close()

    const backlog = createJobLog(directory, "backlog")
    backlog.append(first)
    backlog.append("a".repeat(1024 * 1024))
    backlog.append("overflow")
    await expect(backlog.close()).rejects.toThrow("pending writes exceeded")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
