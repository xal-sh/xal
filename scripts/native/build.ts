import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { hostNativeTarget, nativeTarget, type NativeTarget } from "./targets"
import {
  ARTIFACT_SCHEMA_VERSION,
  NATIVE_API_VERSION,
  sha256File,
  verifyArtifactManifest,
  type ArtifactManifest,
  type ExpectedArtifactMetadata,
} from "./verify"

const ROOT = resolve(import.meta.dir, "../..")
const NATIVE_ROOT = join(ROOT, "apps/cli/.native")
const STAGED_ADDON = join(ROOT, "apps/cli/src/native/xal-native.node")
const STAGING_LOCK = join(ROOT, "apps/cli/src/native/.compile.lock")
const BUILD_MODE = "release"
const BUN_VERSION = "1.3.14"
const CARGO_ZIGBUILD_VERSION = "0.20.1"

interface NativeInputs extends ExpectedArtifactMetadata {
  target: string
  inputHash: string
  sourceHash: string
  lockHash: string
  toolchain: string
  apiVersion: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isExistingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST"
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false
    if (isRecord(error) && error.code === "EPERM") return true
    throw error
  }
}

async function clearStaleCompileLock(): Promise<void> {
  let owner: unknown
  try {
    owner = JSON.parse(await readFile(STAGING_LOCK, "utf8"))
  } catch (error) {
    if (isMissingPath(error)) return
    let lock
    try {
      lock = await stat(STAGING_LOCK)
    } catch (statError) {
      if (isMissingPath(statError)) return
      throw statError
    }
    if (Date.now() - lock.mtimeMs < 5_000) throw new Error("native compile lock is being initialized")
  }
  if (isRecord(owner) && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    if (processIsAlive(owner.pid)) throw new Error(`native compile lock is held by process ${owner.pid}`)
  }
  await rm(STAGING_LOCK, { force: true })
}

async function acquireCompileLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await open(STAGING_LOCK, "wx")
    } catch (error) {
      if (!isExistingPath(error)) throw error
      await clearStaleCompileLock()
    }
  }
  throw new Error("failed to acquire native compile lock")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function relativePath(path: string): string {
  return relative(ROOT, path).split(sep).join("/")
}

async function rustSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await rustSourceFiles(path)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".rs")) files.push(path)
  }
  return files
}

async function cargoManifests(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await cargoManifests(path)))
      continue
    }
    if (entry.isFile() && entry.name === "Cargo.toml") files.push(path)
  }
  return files
}

async function hashFiles(paths: string[]): Promise<string> {
  const hash = createHash("sha256")
  for (const path of paths.sort((left, right) => {
    const leftPath = relativePath(left)
    const rightPath = relativePath(right)
    if (leftPath < rightPath) return -1
    if (leftPath > rightPath) return 1
    return 0
  })) {
    const content = await readFile(path)
    hash.update(relativePath(path))
    hash.update("\0")
    hash.update(String(content.byteLength))
    hash.update("\0")
    hash.update(content)
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function toolchainInput(): Promise<{ path: string; toolchain: string }> {
  const tomlPath = join(ROOT, "rust-toolchain.toml")
  if (await pathExists(tomlPath)) {
    const content = await readFile(tomlPath, "utf8")
    const channel = content.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/m)?.[1]
    if (!channel) throw new Error(`${tomlPath} must define toolchain.channel`)
    return { path: tomlPath, toolchain: `rustc ${channel}` }
  }
  const plainPath = join(ROOT, "rust-toolchain")
  const toolchain = (await readFile(plainPath, "utf8")).trim()
  if (!toolchain) throw new Error(`${plainPath} must name a Rust toolchain`)
  return { path: plainPath, toolchain: `rustc ${toolchain}` }
}

async function nativeInputs(target: NativeTarget, portable: boolean): Promise<NativeInputs> {
  const lockPath = join(ROOT, "Cargo.lock")
  const toolchain = await toolchainInput()
  const sourcePaths = [
    join(ROOT, "Cargo.toml"),
    join(ROOT, "scripts/native/build.ts"),
    join(ROOT, "scripts/native/targets.ts"),
    ...(await cargoManifests(join(ROOT, "crates"))),
    ...(await rustSourceFiles(join(ROOT, "crates/xal-native"))),
    toolchain.path,
  ]
  const sourceHash = await hashFiles(sourcePaths)
  const lockHash = await sha256File(lockPath)
  const builder =
    target.os === "linux" && portable
      ? `cargo-zigbuild@${CARGO_ZIGBUILD_VERSION}`
      : `cargo-${portable ? "portable" : "host"}`
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        sourceHash,
        lockHash,
        toolchain: toolchain.toolchain,
        target: target.rustTarget,
        buildMode: BUILD_MODE,
        builder,
        deploymentTarget: portable ? target.deploymentTarget : undefined,
      }),
    )
    .digest("hex")
  return {
    target: target.rustTarget,
    inputHash,
    sourceHash,
    lockHash,
    toolchain: toolchain.toolchain,
    apiVersion: NATIVE_API_VERSION,
  }
}

async function run(command: string[], env?: Record<string, string | undefined>): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: ROOT,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${command[0]} failed with exit code ${exitCode}`)
}

async function output(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode === 0) return stdout.trim()
  throw new Error(`${command[0]} failed: ${stderr.trim() || `exit code ${exitCode}`}`)
}

async function cargoCommand(
  target: NativeTarget,
  portable: boolean,
): Promise<{ command: string[]; cargoTarget: string }> {
  if (target.os !== "linux" || !portable) {
    return {
      command: [
        process.env.XAL_CARGO ?? process.env.CARGO ?? "cargo",
        "build",
        "--locked",
        "--release",
        "--target",
        target.rustTarget,
      ],
      cargoTarget: target.rustTarget,
    }
  }
  const executable = process.env.XAL_CARGO_ZIGBUILD ?? process.env.CARGO_ZIGBUILD ?? "cargo-zigbuild"
  const version = await output([executable, "--version"])
  if (version !== `cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}`) {
    throw new Error(`Expected cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}, received ${version || "no version"}`)
  }
  const cargoTarget = target.rustTarget.endsWith("-gnu") ? `${target.rustTarget}.2.17` : target.rustTarget
  return {
    command: [executable, "build", "--locked", "--release", "--target", cargoTarget],
    cargoTarget,
  }
}

function manifestFor(inputs: NativeInputs, path: string, sha256: string): ArtifactManifest {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    target: inputs.target,
    inputHash: inputs.inputHash,
    sourceHash: inputs.sourceHash,
    lockHash: inputs.lockHash,
    toolchain: inputs.toolchain,
    apiVersion: inputs.apiVersion,
    path,
    sha256,
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeJson(temporary, value)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function builtLibrary(target: NativeTarget, cargoTarget: string, targetRoot: string): Promise<string> {
  const candidates = [
    join(targetRoot, target.rustTarget, BUILD_MODE, target.libraryFilename),
    join(targetRoot, cargoTarget, BUILD_MODE, target.libraryFilename),
  ]
  for (const path of candidates) {
    if (await pathExists(path)) return path
  }
  throw new Error(`Cargo did not produce ${target.libraryFilename} for ${target.rustTarget}`)
}

async function buildArtifact(target: NativeTarget, inputs: NativeInputs, portable: boolean): Promise<string> {
  const targetRoot = join(NATIVE_ROOT, target.rustTarget)
  const artifactDirectory = join(targetRoot, inputs.inputHash)
  const manifestPath = join(artifactDirectory, "artifact.json")
  if (await pathExists(artifactDirectory)) {
    await verifyArtifactManifest(manifestPath, inputs)
    return manifestPath
  }

  const cargo = await cargoCommand(target, portable)
  const musl = target.rustTarget.endsWith("-musl")
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !musl || !name.toUpperCase().includes("RUSTFLAGS")),
  )
  const buildDirectory = join(ROOT, "target/native-build", portable ? "portable" : "host")
  env.CARGO_TARGET_DIR = buildDirectory
  if (portable && target.deploymentTarget) env.MACOSX_DEPLOYMENT_TARGET = target.deploymentTarget
  if (musl) env.RUSTFLAGS = "-C target-feature=-crt-static"
  await run([...cargo.command, "-p", "xal-native"], env)

  await mkdir(targetRoot, { recursive: true })
  const temporaryDirectory = join(targetRoot, `.${inputs.inputHash}.${randomUUID()}.tmp`)
  try {
    await mkdir(temporaryDirectory)
    const artifactPath = join(temporaryDirectory, "xal-native.node")
    await copyFile(await builtLibrary(target, cargo.cargoTarget, buildDirectory), artifactPath)
    await writeJson(
      join(temporaryDirectory, "artifact.json"),
      manifestFor(inputs, "xal-native.node", await sha256File(artifactPath)),
    )
    try {
      await rename(temporaryDirectory, artifactDirectory)
    } catch (error) {
      if (!(await pathExists(artifactDirectory))) throw error
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  await verifyArtifactManifest(manifestPath, inputs)
  return manifestPath
}

function isCurrentHost(target: NativeTarget): boolean {
  return target.rustTarget === hostNativeTarget().rustTarget
}

async function ensureTarget(target: NativeTarget, portable: boolean): Promise<string> {
  const inputs = await nativeInputs(target, portable)
  const manifestPath = await buildArtifact(target, inputs, portable)
  const manifest = await verifyArtifactManifest(manifestPath, inputs)
  if (isCurrentHost(target)) {
    const hostManifest = manifestFor(
      inputs,
      `${target.rustTarget}/${inputs.inputHash}/xal-native.node`,
      manifest.sha256,
    )
    await writeJsonAtomic(join(NATIVE_ROOT, "host.json"), hostManifest)
    await verifyArtifactManifest(join(NATIVE_ROOT, "host.json"), inputs)
  }
  return manifestPath
}

async function stageArtifact(manifestPath: string): Promise<void> {
  const manifest = await verifyArtifactManifest(manifestPath)
  const source = resolve(dirname(manifestPath), ...manifest.path.split("/"))
  await mkdir(dirname(STAGED_ADDON), { recursive: true })
  const temporary = `${STAGED_ADDON}.${randomUUID()}.tmp`
  try {
    await copyFile(source, temporary)
    await rename(temporary, STAGED_ADDON)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function compile(target: NativeTarget, version: string, outfile: string): Promise<void> {
  if (!version) throw new Error("Version must not be empty")
  if (!outfile) throw new Error("Output path must not be empty")
  if (Bun.version !== BUN_VERSION)
    throw new Error(`Bun ${BUN_VERSION} is required to compile releases, found ${Bun.version}`)
  const manifestPath = await ensureTarget(target, true)
  await mkdir(dirname(STAGING_LOCK), { recursive: true })
  const lock = await acquireCompileLock()
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, target: target.rustTarget })}\n`)
    await lock.sync()
    await rm(STAGED_ADDON, { force: true })
    await verifyArtifactManifest(manifestPath, await nativeInputs(target, true))
    await stageArtifact(manifestPath)
    await run([
      process.env.XAL_BUN ?? "bun",
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      "--define",
      `XAL_VERSION=${JSON.stringify(version)}`,
      join(ROOT, "apps/cli/src/index.ts"),
      `--outfile=${resolve(outfile)}`,
    ])
  } finally {
    try {
      await rm(STAGED_ADDON, { force: true })
    } finally {
      try {
        await lock.close()
      } finally {
        await rm(STAGING_LOCK, { force: true })
      }
    }
  }
}

async function main(): Promise<void> {
  const [command, first, second, third, extra] = process.argv.slice(2)
  if (command === "ensure" && first === undefined) {
    console.log(await ensureTarget(hostNativeTarget(), false))
    return
  }
  if (command === "target" && first !== undefined && second === undefined) {
    console.log(await ensureTarget(nativeTarget(first), true))
    return
  }
  if (command === "compile-host" && first !== undefined && second !== undefined && third === undefined) {
    await compile(hostNativeTarget(), first, second)
    return
  }
  if (
    command === "compile" &&
    first !== undefined &&
    second !== undefined &&
    third !== undefined &&
    extra === undefined
  ) {
    await compile(nativeTarget(first), second, third)
    return
  }
  throw new Error(
    "Usage: bun scripts/native/build.ts ensure | target <rust-target> | compile-host <version> <outfile> | compile <rust-target> <version> <outfile>",
  )
}

if (import.meta.main) await main()
