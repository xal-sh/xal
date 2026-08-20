import { describe, expect, test } from "bun:test"
import { parseNativeManifest, type NativeManifest } from "./manifest"

const hash = "a".repeat(64)

function validManifest(): NativeManifest {
  return {
    apiVersion: 1,
    inputHash: hash,
    lockHash: hash,
    path: `aarch64-apple-darwin/${hash}/xal-native.node`,
    schemaVersion: 1,
    sha256: hash,
    sourceHash: hash,
    target: "aarch64-apple-darwin",
    toolchain: "rustc 1.92.0",
  }
}

describe("native manifest", () => {
  test("accepts the exact manifest shape", () => {
    expect(parseNativeManifest(validManifest())).toEqual(validManifest())
  })

  test("rejects malformed fields and paths", () => {
    expect(() => parseNativeManifest(null)).toThrow("invalid native manifest")
    expect(() => parseNativeManifest({ ...validManifest(), extra: true })).toThrow("invalid native manifest fields")
    expect(() => parseNativeManifest({ ...validManifest(), sha256: hash.toUpperCase() })).toThrow(
      "invalid native manifest sha256",
    )
    expect(() => parseNativeManifest({ ...validManifest(), target: "wasm32-unknown-unknown" })).toThrow(
      "invalid native manifest target",
    )
    expect(() => parseNativeManifest({ ...validManifest(), path: "../xal-native.node" })).toThrow(
      "invalid native manifest path",
    )
    expect(() => parseNativeManifest({ ...validManifest(), path: "target\\xal-native.node" })).toThrow(
      "invalid native manifest path",
    )
  })
})
