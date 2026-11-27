import { rm } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false
    if (isRecord(error) && error.code === "EPERM") return true
    throw error
  }
}

export default async function check(repo: string): Promise<CaseVerdict> {
  const pidFile = Bun.file(join(repo, ".server.pid"))
  const pid = (await pidFile.exists()) ? Number((await pidFile.text()).trim()) : 0
  const validPid = Number.isInteger(pid) && pid > 1 && pid <= 2_147_483_647
  const running = validPid && isRunning(pid)
  await rm(join(repo, ".server.port"), { force: true })
  if (!validPid) return { pass: false, detail: "server never started" }
  if (running) {
    const deadline = Date.now() + 2_000
    while (isRunning(pid)) {
      if (Date.now() >= deadline)
        return { pass: false, detail: "server still running (cleanup could not confirm exit)" }
      await Bun.sleep(25)
    }
    return { pass: false, detail: "server still running" }
  }
  const health = Bun.file(join(repo, "health.txt"))
  if (!(await health.exists()) || (await health.text()).trim() !== "healthy-4b71") {
    return { pass: false, detail: "health.txt missing or wrong" }
  }
  const stopped = Bun.file(join(repo, ".server.stopped"))
  if (!(await stopped.exists()) || (await stopped.text()).trim() !== String(pid)) {
    return { pass: false, detail: "server did not stop gracefully" }
  }
  return { pass: true }
}
