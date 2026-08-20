import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { nativeTargets } from "./targets"

export const ARTIFACT_SCHEMA_VERSION = 1
export const NATIVE_API_VERSION = 1

export interface ArtifactManifest {
  schemaVersion: number
  target: string
  inputHash: string
  sourceHash: string
  lockHash: string
  toolchain: string
  apiVersion: number
  path: string
  sha256: string
}

export interface ExpectedArtifactMetadata {
  target?: string
  inputHash?: string
  sourceHash?: string
  lockHash?: string
  toolchain?: string
  apiVersion?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function isArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return false
  const parts = value.split("/")
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\"))
}

function parseManifest(value: unknown, path: string): ArtifactManifest {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`)
  const keys = new Set([
    "schemaVersion",
    "target",
    "inputHash",
    "sourceHash",
    "lockHash",
    "toolchain",
    "apiVersion",
    "path",
    "sha256",
  ])
  const unexpected = Object.keys(value).filter((key) => !keys.has(key))
  if (unexpected.length > 0) throw new Error(`${path} has unexpected fields: ${unexpected.join(", ")}`)
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`${path} has unsupported schemaVersion`)
  }
  if (typeof value.target !== "string" || !nativeTargets.some((target) => target.rustTarget === value.target)) {
    throw new Error(`${path} has an unsupported target`)
  }
  if (!isSha256(value.inputHash)) throw new Error(`${path} has an invalid inputHash`)
  if (!isSha256(value.sourceHash)) throw new Error(`${path} has an invalid sourceHash`)
  if (!isSha256(value.lockHash)) throw new Error(`${path} has an invalid lockHash`)
  if (typeof value.toolchain !== "string" || value.toolchain.length === 0) {
    throw new Error(`${path} has an invalid toolchain`)
  }
  if (value.apiVersion !== NATIVE_API_VERSION) throw new Error(`${path} has an unsupported apiVersion`)
  if (!isArtifactPath(value.path)) throw new Error(`${path} has an invalid artifact path`)
  if (!isSha256(value.sha256)) throw new Error(`${path} has an invalid sha256`)
  return {
    schemaVersion: value.schemaVersion,
    target: value.target,
    inputHash: value.inputHash,
    sourceHash: value.sourceHash,
    lockHash: value.lockHash,
    toolchain: value.toolchain,
    apiVersion: value.apiVersion,
    path: value.path,
    sha256: value.sha256,
  }
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

export async function readArtifactManifest(path: string): Promise<ArtifactManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`Unable to read artifact manifest ${path}`, { cause: error })
  }
  return parseManifest(value, path)
}

function assertExpected(manifest: ArtifactManifest, expected: ExpectedArtifactMetadata, path: string): void {
  if (expected.target !== undefined && manifest.target !== expected.target) {
    throw new Error(`${path} target does not match the requested build`)
  }
  if (expected.inputHash !== undefined && manifest.inputHash !== expected.inputHash) {
    throw new Error(`${path} inputHash does not match the requested build`)
  }
  if (expected.sourceHash !== undefined && manifest.sourceHash !== expected.sourceHash) {
    throw new Error(`${path} sourceHash does not match the requested build`)
  }
  if (expected.lockHash !== undefined && manifest.lockHash !== expected.lockHash) {
    throw new Error(`${path} lockHash does not match the requested build`)
  }
  if (expected.toolchain !== undefined && manifest.toolchain !== expected.toolchain) {
    throw new Error(`${path} toolchain does not match the requested build`)
  }
  if (expected.apiVersion !== undefined && manifest.apiVersion !== expected.apiVersion) {
    throw new Error(`${path} apiVersion does not match the requested build`)
  }
}

export async function verifyArtifactManifest(
  manifestPath: string,
  expected: ExpectedArtifactMetadata = {},
): Promise<ArtifactManifest> {
  const manifest = await readArtifactManifest(manifestPath)
  assertExpected(manifest, expected, manifestPath)
  const artifactPath = resolve(dirname(manifestPath), ...manifest.path.split("/"))
  if (basename(artifactPath) !== "xal-native.node") {
    throw new Error(`${manifestPath} does not reference xal-native.node`)
  }
  if (basename(dirname(artifactPath)) !== manifest.inputHash) {
    throw new Error(`${manifestPath} artifact path does not match inputHash`)
  }
  if (basename(dirname(dirname(artifactPath))) !== manifest.target) {
    throw new Error(`${manifestPath} artifact path does not match target`)
  }
  const digest = await sha256File(artifactPath)
  if (digest !== manifest.sha256) throw new Error(`${artifactPath} digest does not match ${manifestPath}`)
  return manifest
}

async function main(): Promise<void> {
  if (process.argv.length > 3) throw new Error("Usage: bun scripts/native/verify.ts [manifest]")
  const manifestPath = process.argv[2] ?? join(import.meta.dir, "../../apps/cli/.native/host.json")
  const manifest = await verifyArtifactManifest(resolve(manifestPath))
  console.log(`${manifest.target} ${manifest.inputHash} ${manifest.sha256}`)
}

if (import.meta.main) await main()
