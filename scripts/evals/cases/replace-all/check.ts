import { join } from "node:path"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const table = Bun.file(join(repo, "table.js"))
  if (!(await table.exists())) return { pass: false, detail: "changed other text" }
  const actual = await table.text()
  const seed = await Bun.file(join(import.meta.dir, "repo", "table.js")).text()
  if (actual === seed.replaceAll("padEnd(10)", "padEnd(12)")) return { pass: true }
  if (actual.includes("padEnd(10)")) return { pass: false, detail: "still has padEnd(10)" }
  if (!actual.includes("padEnd(100)") || !actual.includes("padStart(10)")) {
    return { pass: false, detail: "changed padEnd(100) or padStart(10)" }
  }
  return { pass: false, detail: "changed other text" }
}
