import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { asString } from "../../lib/json"
import type { ProcessSandbox } from "../types"

const available = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")

export type SandboxAccess = ProcessSandbox

export function sandboxAvailable(): boolean {
  return available
}

export function sandboxAccessOf(args: Record<string, unknown>): SandboxAccess | undefined {
  if (!sandboxAvailable()) return undefined
  const access = asString(args.sandbox)
  if (access === "read" || access === "workspace") return access
  return undefined
}

export function sandboxRequested(args: Record<string, unknown>): boolean {
  return sandboxAccessOf(args) !== undefined
}

function profilePath(path: string): string {
  return path.replace(/[\\"]/g, (char) => `\\${char}`)
}

export function sandboxLaunch(launch: string[], workspace: string, access: SandboxAccess): string[] {
  const roots = new Set([realpathSync(workspace), realpathSync(tmpdir()), realpathSync("/tmp")])
  const nullDevice = '(literal "/dev/null")'
  const writable = [...[...roots].map((root) => `(subpath "${profilePath(root)}")`), nullDevice]
  const fileWrites =
    access === "read"
      ? `(deny file-write* (require-not ${nullDevice}))`
      : `(deny file-write* (require-not (require-any ${writable.join(" ")})))`
  const profile = ["(version 1)", "(allow default)", "(deny network*)", fileWrites].join("\n")
  return ["/usr/bin/sandbox-exec", "-p", profile, ...launch]
}

export function sandboxProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configured = Number(environment.GIT_CONFIG_COUNT)
  const index = Number.isSafeInteger(configured) && configured >= 0 ? configured : 0
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${index}`]: "false",
  }
}
