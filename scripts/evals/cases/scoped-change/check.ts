import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const readme = await readFile(join(repo, "README.md"), "utf8")
  if (readme !== "# Sample\n\nA sample project.\n") return { pass: false, detail: "edited the unrelated README" }
  const config = await readFile(join(repo, "config.js"), "utf8")
  if (!/timeoutMs:\s*5000/.test(config)) return { pass: false, detail: "timeout not set to 5000" }
  if (!/retries:\s*3/.test(config) || !/verbose:\s*false/.test(config)) {
    return { pass: false, detail: "changed unrelated config values" }
  }
  return { pass: true }
}
