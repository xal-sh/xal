import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

const INVOICE = `import { formatCents, toCents } from "./money.js"

export function invoiceTotal(lines) {
  const cents = lines.reduce((sum, line) => sum + toCents(line.price) * line.quantity, 0)
  return formatCents(cents)
}
`

export default async function check(repo: string): Promise<CaseVerdict> {
  if ((await readFile(join(repo, "invoice.js"), "utf8")) !== INVOICE) {
    return { pass: false, detail: "patched invoice.js instead of the conversion it relies on" }
  }
  const test = await readFile(join(repo, "invoice.test.js"), "utf8")
  if (!test.includes('toBe("$0.87")') || !test.includes('toBe("$29.99")')) {
    return { pass: false, detail: "changed the test expectations" }
  }
  const module: unknown = await import(`${join(repo, "money.js")}?v=${crypto.randomUUID()}`)
  const toCents = isRecord(module) ? module.toCents : undefined
  if (typeof toCents !== "function") return { pass: false, detail: "money.js lost toCents" }
  for (const [amount, cents] of [
    [0.29, 29],
    [1.15, 115],
    [4.35, 435],
    [0.57, 57],
  ] as const) {
    if (toCents(amount) !== cents) return { pass: false, detail: `toCents(${amount}) is not ${cents}` }
  }
  const proc = Bun.spawn(["bun", "test"], { cwd: repo, stdout: "ignore", stderr: "ignore", timeout: 30_000 })
  if ((await proc.exited) !== 0) return { pass: false, detail: "bun test still fails" }
  return { pass: true }
}
