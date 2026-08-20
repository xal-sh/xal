import { spawn } from "node:child_process"
import { chmod, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { appInfo, formatAppVersion } from "../app-info"
import { registerCli } from "../cli/registry"
import type { Cli, CliContext } from "../cli/types"
import { describeError, isMissingPathError } from "../lib/error"
import { isStandalone } from "../lib/process"
import { linuxLibc } from "../native/targets"
import { downloadArtifact } from "./download"

function parseArgs(args: string[]): { help: boolean } {
  let help = false

  for (const arg of args) {
    switch (arg) {
      case "--help":
      case "-h":
        help = true
        break
      default:
        throw new Error(`unknown update option: ${arg}`)
    }
  }

  return { help }
}

function printHelp(ctx: CliContext): void {
  ctx.print(`usage: ${appInfo.name} update`)
  ctx.print("")
  ctx.print("Install the newest beta release.")
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": `${appInfo.name}/${appInfo.version}` } })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}: ${url}`)
  return (await response.text()).trim()
}

function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
    throw new Error(`beta channel returned an invalid version: ${version}`)
  }
}

async function resolveRelease(): Promise<{ base: string; version: string }> {
  const version = await fetchText("https://github.com/xal-sh/xal/releases/download/beta/version.txt")
  validateVersion(version)
  const base = `https://github.com/xal-sh/xal/releases/download/v${version}`
  const releaseVersion = await fetchText(`${base}/version.txt`)
  if (releaseVersion !== version) throw new Error("beta channel version does not match its release")
  return { base, version }
}

function artifactName(): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`unsupported architecture: ${process.arch}`)
  }

  switch (process.platform) {
    case "darwin":
      return `${appInfo.name}-darwin-${process.arch}`
    case "linux":
      return `${appInfo.name}-linux-${process.arch}${linuxLibc() === "musl" ? "-musl" : ""}`
    case "win32":
      return `${appInfo.name}-windows-${process.arch}.exe`
    default:
      throw new Error(`unsupported platform: ${process.platform}`)
  }
}

function expectedChecksum(checksums: string, artifact: string): string {
  for (const line of checksums.split("\n")) {
    const [checksum, name] = line.trim().split(/\s+/)
    if (name === artifact && checksum && /^[a-f0-9]{64}$/.test(checksum)) return checksum
  }
  throw new Error(`release checksums do not contain ${artifact}`)
}

async function verifyInvocation(path: string, argument: string, version: string): Promise<void> {
  const child = Bun.spawn([path, argument], { stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 30_000)
  timeout.unref()
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error(`downloaded executable ${argument} verification timed out`)
    if (exitCode === 0 && stdout.trim() === formatAppVersion(version)) return
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
    throw new Error(`downloaded executable ${argument} verification failed: ${detail}`)
  } finally {
    clearTimeout(timeout)
  }
}

async function verifyExecutable(path: string, version: string): Promise<void> {
  await verifyInvocation(path, "--version", version)
  await verifyInvocation(path, "--native-self-check", version)
}

function batchPath(path: string): string {
  return path.replace(/%/g, "%%")
}

async function scheduleWindowsReplacement(executable: string, downloaded: string): Promise<void> {
  const helper = join(dirname(executable), `.${appInfo.name}-update-${process.pid}.cmd`)
  await writeFile(
    helper,
    [
      "@echo off",
      "setlocal",
      ":retry",
      `move /Y "${batchPath(downloaded)}" "${batchPath(executable)}" >nul 2>&1`,
      "if errorlevel 1 (",
      "  >nul 2>&1 ping 127.0.0.1 -n 2",
      "  goto retry",
      ")",
      'del "%~f0"',
      "",
    ].join("\r\n"),
  )
  const child = spawn("cmd.exe", ["/d", "/s", "/c", helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
}

async function removeDownload(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

async function runUpdate(args: string[], ctx: CliContext): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    printHelp(ctx)
    return
  }
  if (!isStandalone()) throw new Error("xal update is only available in an installed xal binary")

  const { base, version } = await resolveRelease()
  const repairing = version === appInfo.version
  if (repairing) {
    try {
      await verifyInvocation(process.execPath, "--native-self-check", version)
      ctx.print(`${appInfo.name} ${version} is already up to date (beta)`)
      return
    } catch (error) {
      ctx.error(`native self-check failed; repairing ${appInfo.name} ${version}: ${describeError(error)}`)
    }
  }

  const artifact = artifactName()
  ctx.print(`downloading ${appInfo.name} ${version} (beta)`)
  const checksums = await fetchText(`${base}/SHA256SUMS`)
  const bytes = await downloadArtifact(`${base}/${artifact}`, artifact, ctx)
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const expected = expectedChecksum(checksums, artifact)
  if (actual !== expected) throw new Error(`checksum mismatch for ${artifact}`)

  const executable = process.execPath
  const downloaded = join(
    dirname(executable),
    `.${basename(executable)}.update-${process.pid}${process.platform === "win32" ? ".exe" : ""}`,
  )
  let replacementScheduled = false
  try {
    await writeFile(downloaded, bytes, { mode: 0o755 })
    if (process.platform !== "win32") await chmod(downloaded, 0o755)
    await verifyExecutable(downloaded, version)

    if (process.platform === "win32") {
      await scheduleWindowsReplacement(executable, downloaded)
      replacementScheduled = true
      ctx.print(`scheduled ${appInfo.name} ${version} (beta); it will finish installing after exit`)
      return
    }

    await rename(downloaded, executable)
    ctx.print(
      repairing
        ? `repaired ${appInfo.name} ${version} (beta)`
        : `updated ${appInfo.name} ${appInfo.version} → ${version} (beta)`,
    )
  } finally {
    if (!replacementScheduled) await removeDownload(downloaded)
  }
}

const updateCli: Cli = {
  name: "update",
  describe: "update xal to the newest beta release",
  usage: "update",
  run: runUpdate,
}

export function registerUpdateCli(): void {
  registerCli(updateCli)
}
