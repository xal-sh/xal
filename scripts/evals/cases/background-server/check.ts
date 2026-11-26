import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { describeError } from "../../../../apps/cli/src/lib/error"
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
  if (!(await pidFile.exists())) return { pass: false, detail: "server never started" }
  const pid = Number((await pidFile.text()).trim())
  if (!Number.isInteger(pid) || pid <= 1 || pid > 2_147_483_647) return { pass: false, detail: "server never started" }
  if (isRunning(pid)) {
    try {
      const port = Number(await Bun.file(join(repo, ".server.port")).text())
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid .server.port")
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      })
      if (response.headers.get("x-eval-server") !== `${pid}:${encodeURIComponent(await realpath(repo))}`) {
        throw new Error("server identity mismatch")
      }
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if (isRunning(pid))
        return { pass: false, detail: `server still running (cleanup failed: ${describeError(error)})` }
    }
    return { pass: false, detail: "server still running" }
  }
  const health = Bun.file(join(repo, "health.txt"))
  if (!(await health.exists()) || (await health.text()).trim() !== "healthy-4b71") {
    return { pass: false, detail: "health.txt missing or wrong" }
  }
  return { pass: true }
}
