import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describeError } from "../../../../apps/cli/src/lib/error"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

const INVOICE = `import { formatCents, toCents } from "./money.js"

export function invoiceTotal(lines) {
  const cents = lines.reduce((sum, line) => sum + toCents(line.price) * line.quantity, 0)
  return formatCents(cents)
}
`

async function verdict(repo: string): Promise<CaseVerdict> {
  if ((await readFile(join(repo, "invoice.js"), "utf8")) !== INVOICE) {
    return { pass: false, detail: "patched invoice.js instead of the conversion it relies on" }
  }
  const money: unknown = await import(join(repo, "money.js"))
  const toCents = isRecord(money) ? money.toCents : undefined
  if (typeof toCents !== "function") return { pass: false, detail: "money.js lost toCents" }
  for (const [amount, cents] of [
    [0.29, 29],
    [1.15, 115],
    [4.35, 435],
    [0.57, 57],
  ] as const) {
    if (toCents(amount) !== cents) return { pass: false, detail: `toCents(${amount}) is not ${cents}` }
  }
  const invoice: unknown = await import(join(repo, "invoice.js"))
  const invoiceTotal = isRecord(invoice) ? invoice.invoiceTotal : undefined
  if (typeof invoiceTotal !== "function") return { pass: false, detail: "invoice.js lost invoiceTotal" }
  if (
    invoiceTotal([{ price: 0.29, quantity: 3 }]) !== "$0.87" ||
    invoiceTotal([
      { price: 19.99, quantity: 1 },
      { price: 5, quantity: 2 },
    ]) !== "$29.99"
  ) {
    return { pass: false, detail: "invoice totals are still wrong" }
  }
  const proc = Bun.spawn(["bun", "test"], { cwd: repo, stdout: "ignore", stderr: "ignore", timeout: 30_000 })
  if ((await proc.exited) !== 0) return { pass: false, detail: "bun test fails" }
  return { pass: true }
}

export default async function check(repo: string): Promise<CaseVerdict> {
  try {
    return await verdict(repo)
  } catch (error) {
    return { pass: false, detail: `workspace code failed to load or run: ${describeError(error)}` }
  }
}
