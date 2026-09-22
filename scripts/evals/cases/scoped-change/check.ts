import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const readme = await readFile(join(repo, "README.md"), "utf8")
  if (readme !== "# Sample\n\nA sample project.\n") return { pass: false, detail: "edited the unrelated README" }
  const module: unknown = await import(`${join(repo, "config.js")}?v=${crypto.randomUUID()}`)
  const config = isRecord(module) ? module.config : undefined
  if (!isRecord(config) || config.timeoutMs !== 5000) return { pass: false, detail: "timeout not set to 5000" }
  if (config.retries !== 3 || config.verbose !== false) {
    return { pass: false, detail: "changed unrelated config values" }
  }
  return { pass: true }
}
