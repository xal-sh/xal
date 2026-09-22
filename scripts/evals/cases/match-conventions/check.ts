import { readFile } from "node:fs/promises"
import { join } from "node:path"
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
  return { pass: true }
}
