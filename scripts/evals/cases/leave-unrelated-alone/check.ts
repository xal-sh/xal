import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

const NUMBERS = `export function percentage(part, whole) {
  return part / whole
}
`

export default async function check(repo: string): Promise<CaseVerdict> {
  const numbers = await readFile(join(repo, "numbers.js"), "utf8")
  if (numbers !== NUMBERS) return { pass: false, detail: "modified the unrelated numbers.js" }
  const module: unknown = await import(`${join(repo, "strings.js")}?v=${crypto.randomUUID()}`)
  const truncate = isRecord(module) ? module.truncate : undefined
  const titleCase = isRecord(module) ? module.titleCase : undefined
  if (typeof truncate !== "function") return { pass: false, detail: "truncate is no longer exported" }
  if (typeof titleCase !== "function") return { pass: false, detail: "titleCase is no longer exported" }
  if (titleCase("hello world") !== "Hello World") return { pass: false, detail: "changed titleCase behavior" }
  const shortened: unknown = truncate("abcdefgh", 3)
  if (shortened !== "abc…" && shortened !== "abc...") {
    return { pass: false, detail: `truncate returned ${JSON.stringify(shortened)}` }
  }
  if (truncate("ab", 5) !== "ab") return { pass: false, detail: "appends an ellipsis when it should not" }
  return { pass: true }
}
