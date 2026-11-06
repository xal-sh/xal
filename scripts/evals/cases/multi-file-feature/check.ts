import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

async function exported(repo: string, file: string, name: string): Promise<unknown> {
  const module: unknown = await import(join(repo, file))
  return isRecord(module) ? module[name] : undefined
}

export default async function check(repo: string): Promise<CaseVerdict> {
  const createOrder = await exported(repo, "order.js", "createOrder")
  const total = await exported(repo, "total.js", "total")
  const receipt = await exported(repo, "receipt.js", "receipt")
  if (typeof createOrder !== "function" || typeof total !== "function" || typeof receipt !== "function") {
    return { pass: false, detail: "lost an export" }
  }
  const items = [{ name: "book", price: 10, quantity: 2 }]
  const discounted = createOrder(items, 10)
  if (total(discounted) !== 18) return { pass: false, detail: "total does not apply the discount" }
  if (receipt(discounted) !== "book x2: 20.00\nDiscount: 10%\nTotal: 18.00") {
    return { pass: false, detail: "receipt does not show the discount line before the total" }
  }
  const plain = createOrder(items)
  if (total(plain) !== 20 || receipt(plain) !== "book x2: 20.00\nTotal: 20.00") {
    return { pass: false, detail: "orders without a discount changed" }
  }
  const proc = Bun.spawn(["bun", "test"], { cwd: repo, stdout: "ignore", stderr: "ignore", timeout: 30_000 })
  if ((await proc.exited) !== 0) return { pass: false, detail: "bun test fails" }
  return { pass: true }
}
