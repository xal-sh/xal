export type NativeOs = "darwin" | "linux" | "win32"
export type NativeCpu = "x64" | "arm64"
export type LinuxLibc = "gnu" | "musl"

interface NativeTargetProperties {
  bunTarget: string
  os: NativeOs
  cpu: NativeCpu
  libraryFilename: string
  deploymentTarget?: string
}

const nativeTargetRegistry = [
  {
    rustTarget: "x86_64-apple-darwin",
    bunTarget: "bun-darwin-x64-baseline",
    os: "darwin",
    cpu: "x64",
    libraryFilename: "libxal_native.dylib",
    deploymentTarget: "10.13",
  },
  {
    rustTarget: "aarch64-apple-darwin",
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    libraryFilename: "libxal_native.dylib",
    deploymentTarget: "11.0",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    bunTarget: "bun-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
    libraryFilename: "libxal_native.so",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libraryFilename: "libxal_native.so",
  },
  {
    rustTarget: "x86_64-unknown-linux-musl",
    bunTarget: "bun-linux-x64-baseline-musl",
    os: "linux",
    cpu: "x64",
    libraryFilename: "libxal_native.so",
  },
  {
    rustTarget: "aarch64-unknown-linux-musl",
    bunTarget: "bun-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libraryFilename: "libxal_native.so",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    bunTarget: "bun-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
    libraryFilename: "xal_native.dll",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    bunTarget: "bun-windows-arm64",
    os: "win32",
    cpu: "arm64",
    libraryFilename: "xal_native.dll",
  },
] as const satisfies readonly (NativeTargetProperties & { rustTarget: string })[]

export type NativeRustTarget = (typeof nativeTargetRegistry)[number]["rustTarget"]
export type NativeTarget = NativeTargetProperties & { rustTarget: NativeRustTarget }

export const nativeTargets: readonly NativeTarget[] = Object.freeze(
  nativeTargetRegistry.map((target) => Object.freeze(target)),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isNativeRustTarget(value: unknown): value is NativeRustTarget {
  return typeof value === "string" && nativeTargets.some((target) => target.rustTarget === value)
}

export function nativeTarget(rustTarget: string): NativeTarget {
  if (!isNativeRustTarget(rustTarget)) throw new Error(`Unsupported Rust target: ${rustTarget}`)
  const target = nativeTargets.find((candidate) => candidate.rustTarget === rustTarget)
  if (!target) throw new Error(`Unsupported Rust target: ${rustTarget}`)
  return target
}

export function linuxLibc(): LinuxLibc {
  const report: unknown = process.report?.getReport()
  if (!isRecord(report) || !isRecord(report.header)) throw new Error("could not detect the Linux C library")
  return typeof report.header.glibcVersionRuntime === "string" ? "gnu" : "musl"
}

export function hostNativeTarget(): NativeTarget {
  const libc = process.platform === "linux" ? linuxLibc() : undefined
  const target = nativeTargets.find(
    (candidate) =>
      candidate.os === process.platform &&
      candidate.cpu === process.arch &&
      (candidate.os !== "linux" || candidate.rustTarget.endsWith(`-${libc}`)),
  )
  if (!target) throw new Error(`Unsupported native host: ${process.platform}-${process.arch}`)
  return target
}
