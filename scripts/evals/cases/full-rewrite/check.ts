import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

export default async function check(repo: string): Promise<CaseVerdict> {
  const raw = await readFile(join(repo, "package.json"), "utf8")
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    return { pass: false, detail: "package.json is no longer valid JSON" }
  }
  if (!isRecord(manifest)) return { pass: false, detail: "package.json is no longer an object" }
  if (manifest.license !== "MIT") return { pass: false, detail: "license field missing" }
  if (manifest.name !== "sample" || manifest.version !== "1.0.0") {
    return { pass: false, detail: "dropped existing fields" }
  }
  const scripts = manifest.scripts
  if (!isRecord(scripts) || scripts.start !== "bun run index.js") {
    return { pass: false, detail: "dropped the scripts block" }
  }
  return { pass: true }
}
