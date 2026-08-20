import { describe, expect, test } from "bun:test"
import {
  NATIVE_API_VERSION,
  NATIVE_MANIFEST_SCHEMA_VERSION,
  parseNativeManifest,
  type NativeManifest,
} from "./manifest"
import { nativeTargets, type NativeRustTarget } from "./targets"

const hash = "a".repeat(64)

function validManifest(target: NativeRustTarget = "aarch64-apple-darwin"): NativeManifest {
  return {
    apiVersion: NATIVE_API_VERSION,
    inputHash: hash,
    lockHash: hash,
    path: `${target}/${hash}/xal-native.node`,
    schemaVersion: NATIVE_MANIFEST_SCHEMA_VERSION,
    sha256: hash,
    sourceHash: hash,
    target,
    toolchain: "rustc 1.92.0",
  }
}

describe("native manifest", () => {
  test("accepts the exact manifest shape for every native target", () => {
    expect(nativeTargets).toHaveLength(8)
    for (const { rustTarget } of nativeTargets) {
      const manifest = validManifest(rustTarget)
      expect(parseNativeManifest(manifest)).toEqual(manifest)
    }
  })

  test("rejects schema and API version mismatches", () => {
    expect(() =>
      parseNativeManifest({
        ...validManifest(),
        schemaVersion: NATIVE_MANIFEST_SCHEMA_VERSION + 1,
      }),
    ).toThrow("unsupported native manifest schema")
    expect(() =>
      parseNativeManifest({
        ...validManifest(),
        apiVersion: NATIVE_API_VERSION + 1,
      }),
    ).toThrow("unsupported native API version")
  })

  test("rejects missing and empty required fields", () => {
    const missingSha256: Partial<NativeManifest> = validManifest()
    delete missingSha256.sha256
    expect(() => parseNativeManifest(missingSha256)).toThrow("invalid native manifest fields")
    expect(() => parseNativeManifest({ ...validManifest(), toolchain: "" })).toThrow(
      "invalid native manifest toolchain",
    )
  })

  test("rejects malformed fields", () => {
    expect(() => parseNativeManifest(null)).toThrow("invalid native manifest")
    expect(() => parseNativeManifest({ ...validManifest(), extra: true })).toThrow("invalid native manifest fields")
    expect(() => parseNativeManifest({ ...validManifest(), sha256: hash.toUpperCase() })).toThrow(
      "invalid native manifest sha256",
    )
    expect(() => parseNativeManifest({ ...validManifest(), target: "wasm32-unknown-unknown" })).toThrow(
      "invalid native manifest target",
    )
    expect(() => parseNativeManifest({ ...validManifest(), target: 1 })).toThrow("invalid native manifest target")
  })

  test("rejects unsafe and non-normalized paths", () => {
    const target = validManifest().target
    for (const path of [
      "../xal-native.node",
      "target\\xal-native.node",
      `${target}/./${hash}/xal-native.node`,
      `${target}//${hash}/xal-native.node`,
    ]) {
      expect(() => parseNativeManifest({ ...validManifest(), path })).toThrow("invalid native manifest path")
    }
  })
})
