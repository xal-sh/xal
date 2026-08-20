export type NativeOs = "darwin" | "linux" | "win32"
export type NativeCpu = "x64" | "arm64"

export interface NativeTarget {
  rustTarget: string
  bunTarget: string
  releaseAsset: string
  os: NativeOs
  cpu: NativeCpu
  hostRunner: string
  libraryFilename: string
  deploymentTarget?: string
}

export const nativeTargets: readonly NativeTarget[] = Object.freeze([
  Object.freeze({
    rustTarget: "x86_64-apple-darwin",
    bunTarget: "bun-darwin-x64-baseline",
    releaseAsset: "xal-darwin-x64",
    os: "darwin",
    cpu: "x64",
    hostRunner: "macos-15-intel",
    libraryFilename: "libxal_native.dylib",
    deploymentTarget: "10.13",
  }),
  Object.freeze({
    rustTarget: "aarch64-apple-darwin",
    bunTarget: "bun-darwin-arm64",
    releaseAsset: "xal-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    hostRunner: "macos-15",
    libraryFilename: "libxal_native.dylib",
    deploymentTarget: "11.0",
  }),
  Object.freeze({
    rustTarget: "x86_64-unknown-linux-gnu",
    bunTarget: "bun-linux-x64-baseline",
    releaseAsset: "xal-linux-x64",
    os: "linux",
    cpu: "x64",
    hostRunner: "ubuntu-24.04",
    libraryFilename: "libxal_native.so",
  }),
  Object.freeze({
    rustTarget: "aarch64-unknown-linux-gnu",
    bunTarget: "bun-linux-arm64",
    releaseAsset: "xal-linux-arm64",
    os: "linux",
    cpu: "arm64",
    hostRunner: "ubuntu-24.04-arm",
    libraryFilename: "libxal_native.so",
  }),
  Object.freeze({
    rustTarget: "x86_64-unknown-linux-musl",
    bunTarget: "bun-linux-x64-baseline-musl",
    releaseAsset: "xal-linux-x64-musl",
    os: "linux",
    cpu: "x64",
    hostRunner: "ubuntu-24.04",
    libraryFilename: "libxal_native.so",
  }),
  Object.freeze({
    rustTarget: "aarch64-unknown-linux-musl",
    bunTarget: "bun-linux-arm64-musl",
    releaseAsset: "xal-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    hostRunner: "ubuntu-24.04-arm",
    libraryFilename: "libxal_native.so",
  }),
  Object.freeze({
    rustTarget: "x86_64-pc-windows-msvc",
    bunTarget: "bun-windows-x64-baseline",
    releaseAsset: "xal-windows-x64.exe",
    os: "win32",
    cpu: "x64",
    hostRunner: "windows-2025",
    libraryFilename: "xal_native.dll",
  }),
  Object.freeze({
    rustTarget: "aarch64-pc-windows-msvc",
    bunTarget: "bun-windows-arm64",
    releaseAsset: "xal-windows-arm64.exe",
    os: "win32",
    cpu: "arm64",
    hostRunner: "windows-11-arm",
    libraryFilename: "xal_native.dll",
  }),
])

export function nativeTarget(rustTarget: string): NativeTarget {
  const target = nativeTargets.find((candidate) => candidate.rustTarget === rustTarget)
  if (target) return target
  throw new Error(`Unsupported Rust target: ${rustTarget}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hostUsesMusl(): boolean {
  if (process.platform !== "linux") return false
  const report: unknown = process.report?.getReport()
  if (!isRecord(report) || !isRecord(report.header)) throw new Error("Unable to detect the Linux C library")
  return typeof report.header.glibcVersionRuntime !== "string"
}

export function hostNativeTarget(): NativeTarget {
  const musl = hostUsesMusl()
  const target = nativeTargets.find(
    (candidate) =>
      candidate.os === process.platform &&
      candidate.cpu === process.arch &&
      candidate.rustTarget.endsWith("-musl") === musl,
  )
  if (target) return target
  throw new Error(`Unsupported native host: ${process.platform}-${process.arch}`)
}
