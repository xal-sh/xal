import { createHash } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  type BigIntStats,
} from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { isRecord } from "../../lib/json"
import { createNativeSessionLock } from "../../native"

export const MAX_PLUGIN_BYTES = 64 * 1024

export interface ApprovalVersion {
  installation: string
  generation: number
}

export interface ApprovalRevision extends ApprovalVersion {
  stamp?: string
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function notFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

export function scopedPathExists(root: string, path: string, kind: "directory" | "file"): boolean {
  if (!statSync(root).isDirectory()) throw new Error(`expected a scope directory: ${root}`)
  let current = root
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part)
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (!entry) return false
    const expected = current === path ? kind : "directory"
    if (expected === "directory" ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`expected a plugin ${expected}: ${current}`)
    }
  }
  return true
}

function stamp(entry: BigIntStats): string {
  return `${entry.dev}:${entry.ino}:${entry.ctimeNs}:${entry.size}`
}

export function revocationFile(home: string, file: string, installation: string): string {
  return join(home, "approved-plugins", "revocations", digest(`${relative(home, file)}\0${installation}`))
}

export function revokedThrough(home: string, marker: string): number {
  if (!scopedPathExists(home, marker, "file")) return -1
  let text: string
  try {
    text = readFileSync(marker, "utf8")
  } catch (error) {
    if (notFound(error)) return -1
    throw error
  }
  if (!text.length) return -1
  let latest = -1
  for (const line of text.trimEnd().split("\n")) {
    const generation = Number(line)
    if (!/^\d+$/.test(line) || !Number.isSafeInteger(generation))
      throw new Error(`invalid plugin revocation: ${marker}`)
    latest = Math.max(latest, generation)
  }
  return latest
}

export function recordRevocation(home: string, marker: string, generation: number): void {
  if (revokedThrough(home, marker) >= generation) return
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 })
  appendFileSync(marker, `${generation}\n`, { mode: 0o600 })
}

export function clearRevocation(home: string, marker: string): void {
  if (scopedPathExists(home, marker, "file")) rmSync(marker, { force: true })
}

export function unchangedApproval(home: string, file: string, marker: string, previous?: string): boolean {
  return !!previous && stamp(lstatSync(file, { bigint: true })) === previous && !scopedPathExists(home, marker, "file")
}

export function readApproval(home: string, file: string) {
  if (!scopedPathExists(home, file, "file")) return undefined
  const fd = openSync(file, "r")
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size > 6 * MAX_PLUGIN_BYTES + 1024)
      throw new Error(`invalid approved plugin file: ${file}`)
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"))
    if (
      !isRecord(value) ||
      typeof value.source !== "string" ||
      Buffer.byteLength(value.source) > MAX_PLUGIN_BYTES ||
      typeof value.sha256 !== "string" ||
      value.sha256 !== digest(value.source)
    )
      throw new Error("invalid approved plugin snapshot")
    const legacy = value.installation === undefined && value.revision === undefined
    const installation = legacy ? value.sha256 : value.installation
    const revision = legacy ? value.sha256 : value.revision
    if (typeof installation !== "string" || !installation || typeof revision !== "string" || !revision) {
      throw new Error("invalid approved plugin revision")
    }
    const generation = value.generation === undefined ? 0 : value.generation
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("invalid approved plugin generation")
    }
    return { source: value.source, sha256: value.sha256, installation, generation, revision, stamp: stamp(info) }
  } finally {
    closeSync(fd)
  }
}

function openLock(home: string, file: string) {
  scopedPathExists(home, file, "file")
  return createNativeSessionLock(file)
}

export async function withPublicationLock<T>(home: string, change: () => Promise<T>): Promise<T> {
  const file = join(home, "approved-plugins-publication.lock")
  const deadline = performance.now() + 2_000
  let lock: ReturnType<typeof openLock>
  for (;;) {
    try {
      lock = openLock(home, file)
      break
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== `session is already open in another client: ${file}` ||
        performance.now() >= deadline
      )
        throw error
      await Bun.sleep(10)
    }
  }
  try {
    return await change()
  } finally {
    lock.close()
  }
}

export function withApprovalLock<T>(home: string, change: () => T): T {
  const lock = openLock(home, join(home, "approved-plugins.lock"))
  try {
    return change()
  } finally {
    lock.close()
  }
}
