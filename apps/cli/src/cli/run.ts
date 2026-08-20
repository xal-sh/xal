import { formatAppVersion } from "../app-info"
import { describeError } from "../lib/error"
import { printCliHelp, printHelp } from "./help"
import { resolveCli } from "./registry"
import type { CliContext } from "./types"

export async function runCli(args: string[], ctx: CliContext): Promise<void> {
  const first = args[0]
  if (!first || first === "--help" || first === "-h" || first === "help") {
    printHelp(ctx)
    return
  }
  if (first === "--version" || first === "-v" || first === "version") {
    ctx.print(formatAppVersion())
    return
  }

  const resolved = resolveCli(args)
  if (!resolved) {
    ctx.error(`unknown command: ${first}`)
    printHelp(ctx)
    process.exitCode = 1
    return
  }

  if (!resolved.cli.run) {
    const unknown = resolved.args[0]
    if (unknown) ctx.error(`unknown ${resolved.cli.name} target: ${unknown}`)
    printCliHelp(resolved.cli, ctx)
    if (unknown) process.exitCode = 1
    return
  }

  try {
    await resolved.cli.run(resolved.args, ctx)
  } catch (error) {
    ctx.error(describeError(error))
    process.exitCode = 1
  }
}
