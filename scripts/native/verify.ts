import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { parseNativeManifest, type NativeManifest } from "../../apps/cli/src/native/manifest"
import type { NativeRustTarget } from "../../apps/cli/src/native/targets"

export {
  NATIVE_API_VERSION,
  NATIVE_MANIFEST_SCHEMA_VERSION as ARTIFACT_SCHEMA_VERSION,
} from "../../apps/cli/src/native/manifest"

export type ArtifactManifest = NativeManifest

export interface ExpectedArtifactMetadata {
  target?: NativeRustTarget
  inputHash?: string
  sourceHash?: string
  lockHash?: string
  toolchain?: string
  apiVersion?: number
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
  return parseNativeManifest(value)
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
