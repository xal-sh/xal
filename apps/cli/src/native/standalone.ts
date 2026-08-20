import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import embedded from "./xal-native.node" with { type: "file" }

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matchesDigest(path: string, hash: string): boolean {
  try {
    return digest(readFileSync(path)) === hash
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

class UnsafeExtractionPathError extends Error {}

function ensurePrivateDirectory(path: string, uid: number | undefined): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (!existsSync(path)) throw error
    }
  }
  const stats = lstatSync(path)
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new UnsafeExtractionPathError(`native extraction path is not a directory: ${path}`)
  if (uid !== undefined && stats.uid !== uid)
    throw new UnsafeExtractionPathError(`native extraction path is not owned by the current user: ${path}`)
  chmodSync(path, 0o700)
}

function extractionRoot(uid: number | undefined): string {
  const root = join(tmpdir(), uid === undefined ? "xal-native" : `xal-native-${uid}`)
  try {
    ensurePrivateDirectory(root, uid)
    return root
  } catch (error) {
    if (!(error instanceof UnsafeExtractionPathError)) throw error
    const fallback = mkdtempSync(join(tmpdir(), "xal-native-"))
    ensurePrivateDirectory(fallback, uid)
    return fallback
  }
}

export function loadStandaloneBinding(): unknown {
  const bytes = readFileSync(embedded)
  const hash = digest(bytes)
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const root = extractionRoot(uid)
  const platform = join(root, `${process.platform}-${process.arch}`)
  const directory = join(platform, hash)
  const extracted = join(directory, "xal-native.node")
  ensurePrivateDirectory(platform, uid)
  ensurePrivateDirectory(directory, uid)

  if (!matchesDigest(extracted, hash)) {
    const temporary = join(directory, `.${process.pid}-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
      try {
        renameSync(temporary, extracted)
      } catch (error) {
        if (matchesDigest(extracted, hash)) return import.meta.require(extracted)
        if (!isRecord(error) || error.code !== "EEXIST") throw error
        rmSync(extracted, { force: true })
        try {
          renameSync(temporary, extracted)
        } catch (replacementError) {
          if (!matchesDigest(extracted, hash)) throw replacementError
        }
      }
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  if (!matchesDigest(extracted, hash)) throw new Error("extracted native addon checksum mismatch")
  return import.meta.require(extracted)
}
