import { join } from "node:path"
import { describeError } from "../../../../apps/cli/src/lib/error"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

async function exported(repo: string, file: string, name: string): Promise<unknown> {
  const module: unknown = await import(join(repo, file))
  return isRecord(module) ? module[name] : undefined
}

function near(actual: unknown, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-9
}

async function verdict(repo: string): Promise<CaseVerdict> {
  const createOrder = await exported(repo, "order.js", "createOrder")
  const total = await exported(repo, "total.js", "total")
  const receipt = await exported(repo, "receipt.js", "receipt")
  if (typeof createOrder !== "function" || typeof total !== "function" || typeof receipt !== "function") {
    return { pass: false, detail: "lost an export" }
  }
  const items = [
    { name: "book", price: 10, quantity: 2 },
    { name: "pen", price: 1.5, quantity: 2 },
  ]
  const ten = createOrder(items, 10)
  const five = createOrder(items, 5)
  if (!near(total(ten), 20.7) || !near(total(five), 21.85)) {
    return { pass: false, detail: "total does not apply the discount" }
  }
  if (
    receipt(ten) !== "book x2: 20.00\npen x2: 3.00\nDiscount: 10%\nTotal: 20.70" ||
    receipt(five) !== "book x2: 20.00\npen x2: 3.00\nDiscount: 5%\nTotal: 21.85"
  ) {
    return { pass: false, detail: "receipt does not show the discount line before the total" }
  }
  const plain = createOrder(items)
  if (!near(total(plain), 23) || receipt(plain) !== "book x2: 20.00\npen x2: 3.00\nTotal: 23.00") {
    return { pass: false, detail: "orders without a discount changed" }
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
