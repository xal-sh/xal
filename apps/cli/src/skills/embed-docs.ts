import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export function embedDocs(): Record<string, string> {
  const directory = resolve(import.meta.dir, "../../../../docs")
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  )
}
