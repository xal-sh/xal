import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const files = (await readdir(repo)).filter((name) => name.endsWith(".js"))
  for (const name of files) {
    if (/\bqty\b/.test(await readFile(join(repo, name), "utf8"))) {
      return { pass: false, detail: `${name} still uses qty` }
    }
  }
  const proc = Bun.spawn(["bun", "test"], { cwd: repo, stdout: "ignore", stderr: "ignore" })
  if ((await proc.exited) !== 0) return { pass: false, detail: "bun test fails after the rename" }
  return { pass: true }
}
