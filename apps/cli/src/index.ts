import { runCli } from "./cli/run"
import type { CliContext } from "./cli/types"
import { describeError } from "./lib/error"
import { registerNativeCli } from "./native/cli"
import { registerUpdateCli } from "./update/cli"

type App = typeof import("./app")

const lightweightContext: CliContext = {
  print(line) {
    console.log(line)
  },
  error(line) {
    console.error(line)
  },
  async ask() {
    throw new Error("interactive input is unavailable for lightweight commands")
  },
  async askSecret() {
    throw new Error("secret input is unavailable for lightweight commands")
  },
}

let terminationRequested = false
let app: App | undefined

function parseGlobalOptions(input: string[]): { profile: boolean; args: string[] } {
  let profile = false
  let index = 0
  while (input[index]?.startsWith("-")) {
    const option = input[index]!
    if (option !== "--profile") break
    if (profile) throw new Error("duplicate option: --profile")
    profile = true
    index++
  }
  return { profile, args: input.slice(index) }
}

function normalize(args: string[]): string[] {
  const first = args[0]
  if (first === "-c" || first === "--continue") return ["resume", ...args.slice(1)]
  return args
}

function runsWithoutApp(args: string[]): boolean {
  const first = args[0]
  return (
    first === "update" ||
    first === "--version" ||
    first === "-v" ||
    first === "version" ||
    first === "--native-self-check"
  )
}

async function main(input: string[]): Promise<void> {
  const options = parseGlobalOptions(input)
  const args = normalize(options.args)
  registerUpdateCli()
  registerNativeCli()
  if (runsWithoutApp(args)) {
    await runCli(args, lightweightContext)
    return
  }

  const loaded = await import("./app")
  app = loaded
  if (terminationRequested) return
  await loaded.runApp(args, options.profile, () => terminationRequested)
}

let exitRun: Promise<never> | undefined

function finish(): Promise<never> {
  exitRun ??= (async () => {
    await app?.finishApp()
    await Promise.all([
      new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
      new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
    ])
    process.exit(process.exitCode ?? 0)
  })()
  return exitRun
}

function terminate(code: number): void {
  terminationRequested = true
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code
  setTimeout(() => process.exit(code), 7_000).unref()
  void finish()
}

process.once("SIGTERM", () => terminate(143))
process.once("SIGHUP", () => terminate(129))
process.on("SIGINT", () => {
  if (process.listenerCount("SIGINT") > 1) return
  terminate(130)
})

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(app ? app.describeAppError(error) : describeError(error))
  process.exitCode = 1
}
await finish()
