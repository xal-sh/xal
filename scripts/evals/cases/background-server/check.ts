import { unlink } from "node:fs/promises"
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
  const pidPath = join(repo, ".server.pid")
  const pidFile = Bun.file(pidPath)
  if (!(await pidFile.exists())) return { pass: false, detail: "server never started" }
  const pid = Number((await pidFile.text()).trim())
  if (!Number.isInteger(pid) || pid <= 1 || pid > 2_147_483_647) return { pass: false, detail: "server never started" }
  if (isRunning(pid)) {
    await unlink(pidPath)
    return { pass: false, detail: "server still running" }
  }
  const health = Bun.file(join(repo, "health.txt"))
  if (!(await health.exists()) || (await health.text()).trim() !== "healthy-4b71") {
    return { pass: false, detail: "health.txt missing or wrong" }
  }
  return { pass: true }
}
