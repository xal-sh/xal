import type { ChildProcess } from "node:child_process"
import { linuxLibc } from "../native/targets"

export function isStandalone(): boolean {
  return Bun.main.startsWith("/$bunfs/")
}

export function selfCommand(args: string[]): string[] {
  if (isStandalone()) return [process.execPath, ...args]
  return [process.execPath, Bun.main, ...args]
}

export function usesMusl(): boolean {
  if (process.platform !== "linux") return false
  return linuxLibc() === "musl"
}

export function killProcessTree(process: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.pid === undefined) return
  try {
    globalThis.process.kill(-process.pid, signal)
  } catch {
    if (process.exitCode !== null || process.signalCode !== null) return
    process.kill(signal)
  }
}
