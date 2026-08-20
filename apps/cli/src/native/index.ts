import { readFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { isRecord } from "../lib/json"
import { isStandalone } from "../lib/process"
import { readNativeManifest } from "./manifest"

const NATIVE_API_VERSION = 1

export interface NativeSecretMatcher {
  redact(text: string): string
}

interface NativeBinding {
  createSecretMatcher(values: string[], marker: string): NativeSecretMatcher
}

function digest(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
}

function hostTarget(): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`unsupported native architecture: ${process.arch}`)
  }
  if (process.platform === "darwin") {
    return process.arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin"
  }
  if (process.platform === "win32") {
    return process.arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc"
  }
  if (process.platform !== "linux") throw new Error(`unsupported native platform: ${process.platform}`)
  const report: unknown = process.report?.getReport()
  if (!isRecord(report) || !isRecord(report.header)) throw new Error("could not detect the Linux C library")
  const libc = typeof report.header.glibcVersionRuntime === "string" ? "gnu" : "musl"
  return `${process.arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-${libc}`
}

function loadSourceBinding(): unknown {
  const nativeRoot = resolve(import.meta.dir, "../../.native")
  const manifest = readNativeManifest(resolve(nativeRoot, "host.json"))
  if (manifest.target !== hostTarget()) throw new Error("native addon target does not match this host")
  if (manifest.path !== `${manifest.target}/${manifest.inputHash}/xal-native.node`) {
    throw new Error("native addon manifest path does not match its generation")
  }
  const addon = resolve(nativeRoot, manifest.path)
  const addonRelative = relative(nativeRoot, addon)
  if (!addonRelative || addonRelative === ".." || addonRelative.startsWith(`..${sep}`)) {
    throw new Error("native addon path escapes native root")
  }
  if (digest(addon) !== manifest.sha256) throw new Error("native addon checksum mismatch")
  return import.meta.require(addon)
}

function loadBindingValue(): unknown {
  if (!isStandalone()) return loadSourceBinding()
  const module: unknown = require("./standalone")
  if (!isRecord(module)) throw new Error("native standalone loader is invalid")
  const load = module.loadStandaloneBinding
  if (typeof load !== "function") throw new Error("native standalone loader is invalid")
  return Reflect.apply(load, module, [])
}

function createBinding(value: unknown): NativeBinding {
  if (!isRecord(value)) throw new Error("native addon exports are invalid")
  if (typeof value.apiVersion !== "function") throw new Error("native addon apiVersion export is invalid")
  const version: unknown = Reflect.apply(value.apiVersion, value, [])
  if (version !== NATIVE_API_VERSION) throw new Error(`native addon API version mismatch: ${String(version)}`)
  const Matcher = value.NativeSecretMatcher
  if (typeof Matcher !== "function") throw new Error("native addon NativeSecretMatcher export is invalid")

  return {
    createSecretMatcher(values, marker) {
      const instance: unknown = Reflect.construct(Matcher, [values, marker])
      if (!isRecord(instance)) throw new Error("native addon matcher instance is invalid")
      const redact = instance.redact
      if (typeof redact !== "function") throw new Error("native addon matcher instance is invalid")
      return {
        redact(text) {
          const output: unknown = Reflect.apply(redact, instance, [text])
          if (typeof output !== "string") throw new Error("native addon matcher returned an invalid value")
          return output
        },
      }
    },
  }
}

let binding: NativeBinding | undefined

function nativeBinding(): NativeBinding {
  binding ??= createBinding(loadBindingValue())
  return binding
}

export function createNativeSecretMatcher(values: string[], marker: string): NativeSecretMatcher {
  return nativeBinding().createSecretMatcher(values, marker)
}

export function selfCheck(): void {
  const matcher = createNativeSecretMatcher(["native-secret"], "[REDACTED]")
  if (matcher.redact("before native-secret after") !== "before [REDACTED] after") {
    throw new Error("native addon self-check failed")
  }
}
