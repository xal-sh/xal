import { join } from "node:path"
import { describeError } from "../../../../apps/cli/src/lib/error"
import { isRecord } from "../../../../apps/cli/src/lib/json"
import type { CaseVerdict } from "../../types"

function calls(run: (send: (name: string) => never) => unknown): number {
  let count = 0
  try {
    run(() => {
      count += 1
      throw new Error("offline")
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "offline") throw error
    return count
  }
  return count
}

async function verdict(repo: string): Promise<CaseVerdict> {
  const module: unknown = await import(join(repo, "client.js"))
  if (!isRecord(module)) return { pass: false, detail: "client.js does not load" }
  const { upload, download, sync } = module
  if (typeof upload !== "function" || typeof download !== "function" || typeof sync !== "function") {
    return { pass: false, detail: "client.js lost an export" }
  }
  if (calls((send) => upload(send, "file")) !== 5) return { pass: false, detail: "upload does not try 5 times" }
  if (calls((send) => download(send, "id")) !== 3 || calls((send) => sync(send)) !== 3) {
    return { pass: false, detail: "changed attempts outside upload" }
  }
  return { pass: true }
}

export default async function check(repo: string): Promise<CaseVerdict> {
  try {
    return await verdict(repo)
  } catch (error) {
    return { pass: false, detail: `workspace code failed to load or run: ${describeError(error)}` }
  }
}
