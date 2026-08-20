import { readFileSync } from "node:fs"
import { isAbsolute, posix } from "node:path"
import { asNumber, asString, isRecord } from "../lib/json"

const NATIVE_TARGETS = new Set([
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
])

const MANIFEST_KEYS = [
  "apiVersion",
  "inputHash",
  "lockHash",
  "path",
  "schemaVersion",
  "sha256",
  "sourceHash",
  "target",
  "toolchain",
]

export interface NativeManifest {
  apiVersion: number
  inputHash: string
  lockHash: string
  path: string
  schemaVersion: number
  sha256: string
  sourceHash: string
  target: string
  toolchain: string
}

function requireHash(value: unknown, field: string): string {
  const hash = asString(value)
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid native manifest ${field}`)
  return hash
}

export function parseNativeManifest(value: unknown): NativeManifest {
  if (!isRecord(value)) throw new Error("invalid native manifest")
  const keys = Object.keys(value).sort()
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
    throw new Error("invalid native manifest fields")
  }

  const schemaVersion = asNumber(value.schemaVersion)
  if (schemaVersion !== 1) throw new Error("unsupported native manifest schema")
  const apiVersion = asNumber(value.apiVersion)
  if (apiVersion !== 1) throw new Error("unsupported native API version")
  const target = asString(value.target)
  if (!target || !NATIVE_TARGETS.has(target)) throw new Error("invalid native manifest target")
  const toolchain = asString(value.toolchain)
  if (!toolchain) throw new Error("invalid native manifest toolchain")
  const path = asString(value.path)
  if (!path || isAbsolute(path) || path.includes("\\") || posix.normalize(path) !== path) {
    throw new Error("invalid native manifest path")
  }
  if (path === ".." || path.startsWith("../") || path.split("/").some((segment) => !segment || segment === ".")) {
    throw new Error("invalid native manifest path")
  }

  return {
    apiVersion,
    inputHash: requireHash(value.inputHash, "inputHash"),
    lockHash: requireHash(value.lockHash, "lockHash"),
    path,
    schemaVersion,
    sha256: requireHash(value.sha256, "sha256"),
    sourceHash: requireHash(value.sourceHash, "sourceHash"),
    target,
    toolchain,
  }
}

export function readNativeManifest(path: string): NativeManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  return parseNativeManifest(parsed)
}
