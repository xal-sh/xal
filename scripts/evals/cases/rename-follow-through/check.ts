import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CaseVerdict } from "../../types"

async function passes(repo: string, command: string[]): Promise<boolean> {
  const proc = Bun.spawn(command, { cwd: repo, stdout: "ignore", stderr: "ignore", timeout: 30_000 })
  return (await proc.exited) === 0
}

export default async function check(repo: string): Promise<CaseVerdict> {
  const files = (await readdir(repo)).filter((name) => name.endsWith(".js"))
  for (const name of files) {
    if (/\bqty\b/.test(await readFile(join(repo, name), "utf8"))) {
      return { pass: false, detail: `${name} still uses qty` }
    }
  }
  const renamed = 'import { order } from "./order.js"; process.exit(order("apple", 2, 3).quantity === 2 ? 0 : 1)'
  if (!(await passes(repo, ["bun", "--eval", renamed]))) {
    return { pass: false, detail: "order does not produce a quantity field" }
  }
  if (!(await passes(repo, ["bun", "test"]))) return { pass: false, detail: "bun test fails after the rename" }
  return { pass: true }
}
