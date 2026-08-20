import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

async function execute(executable: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode === 0) return stdout.trim()
  throw new Error(`${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`)
}

async function main(): Promise<void> {
  const [executableInput, version, extra] = process.argv.slice(2)
  if (!executableInput || !version || extra !== undefined) {
    throw new Error("Usage: bun scripts/native/smoke.ts <executable> <version>")
  }
  const executable = resolve(executableInput)
  if (process.platform !== "win32") await chmod(executable, 0o755)
  const directory = await mkdtemp(join(tmpdir(), "xal-native-smoke-"))
  try {
    const home = join(directory, "home")
    const plugin = join(directory, "plugin")
    const project = join(directory, "project")
    const nativeTemp = join(directory, "native-temp")
    await Promise.all([mkdir(home), mkdir(plugin), mkdir(project), mkdir(nativeTemp)])
    await writeFile(
      join(plugin, "plugin.ts"),
      [
        "export default {",
        '  name: "native-plugin-smoke",',
        "  register(ctx) {",
        '    ctx.registerSecrets(["plugin-native-secret"])',
        "    ctx.registerCli({",
        '      name: "native-plugin-smoke",',
        '      describe: "exercise native redaction",',
        "      async run(_args, command) {",
        '        command.print("plugin-native-secret")',
        "      },",
        "    })",
        "  },",
        "}",
        "",
      ].join("\n"),
    )
    await writeFile(join(home, "config.json"), `${JSON.stringify({ plugins: [plugin] })}\n`)
    const expectedVersion = `xal ${version}`
    if ((await execute(executable, ["--version"], project)) !== expectedVersion) {
      throw new Error("standalone version smoke output mismatch")
    }
    const nativeEnvironment = { TMPDIR: nativeTemp, TEMP: nativeTemp, TMP: nativeTemp }
    const selfChecks = await Promise.all(
      Array.from({ length: 4 }, () => execute(executable, ["--native-self-check"], project, nativeEnvironment)),
    )
    if (selfChecks.some((output) => output !== expectedVersion)) {
      throw new Error("standalone native self-check output mismatch")
    }
    const extracted = (await readdir(nativeTemp, { recursive: true })).filter((path) =>
      path.endsWith("xal-native.node"),
    )
    if (extracted.length !== 1) throw new Error("standalone native extraction smoke found an unexpected addon count")
    await writeFile(join(nativeTemp, extracted[0]!), "corrupt")
    if ((await execute(executable, ["--native-self-check"], project, nativeEnvironment)) !== expectedVersion) {
      throw new Error("standalone native extraction repair output mismatch")
    }
    if (
      (await execute(executable, ["native-plugin-smoke"], project, { ...nativeEnvironment, XAL_HOME: home })) !==
      "[REDACTED]"
    ) {
      throw new Error("standalone plugin redaction smoke output mismatch")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
