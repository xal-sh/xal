import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const source = await readFile(join(repo, "shapes.js"), "utf8")
  if (!/area_of_triangle/.test(source)) return { pass: false, detail: "function not added" }
  if (!source.includes("export { area_of_circle, area_of_square, area_of_triangle }")) {
    return { pass: false, detail: "not exported alongside the others" }
  }
  if (/^\s*(\/\/|\/\*)/m.test(source)) return { pass: false, detail: "added comments the file does not use" }
  if (/;\s*$/m.test(source)) return { pass: false, detail: "added semicolons the file does not use" }
  if (!/const area_of_triangle = \(/.test(source)) return { pass: false, detail: "did not match the arrow-const style" }
  const module: unknown = await import(`${join(repo, "shapes.js")}?v=${crypto.randomUUID()}`)
  const areaOfTriangle = isRecord(module) ? module.area_of_triangle : undefined
  if (typeof areaOfTriangle !== "function") return { pass: false, detail: "area_of_triangle is not a function" }
  const area: unknown = areaOfTriangle(4, 3)
  if (area !== 6) return { pass: false, detail: `area_of_triangle(4, 3) returned ${JSON.stringify(area)}` }
  return { pass: true }
}
