import { join } from "node:path"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  for (const name of ["slugify.js", "slugify.test.js"]) {
    if (!(await Bun.file(join(repo, name)).exists())) return { pass: false, detail: `${name} missing` }
  }

  const run = (...args: string[]) =>
    Bun.spawn(["bun", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore", timeout: 30_000 }).exited
  if ((await run("test")) !== 0) return { pass: false, detail: "bun test fails" }

  for (const [input, expected] of Object.entries({
    "  Hello, World!  ": "hello-world",
    "Already-slugged": "already-slugged",
    "a  --  b": "a-b",
    "***": "",
  })) {
    const probe = `import { slugify } from "./slugify.js"; process.exit(slugify(${JSON.stringify(input)}) === ${JSON.stringify(expected)} ? 0 : 1)`
    if ((await run("--eval", probe)) !== 0) return { pass: false, detail: `slugify(${JSON.stringify(input)}) failed` }
  }
  return { pass: true }
}
