import { appInfo } from "../app-info"
import { settings } from "../config/settings"
import { defaultPermissionMode, permissionModes } from "../permissions/modes"
import { listClis } from "./registry"
import type { Cli, CliContext } from "./types"

function entry(usage: string, describe: string): string {
  return `  ${`${appInfo.name} ${usage}`.padEnd(26)}${describe}`
}

export function printHelp(ctx: CliContext): void {
  ctx.print(`${appInfo.name} v${appInfo.version}`)
  ctx.print("")
  ctx.print(`usage: ${appInfo.name} [--profile] [--mode name] [command]`)
  ctx.print("")
  ctx.print(`  ${appInfo.name.padEnd(26)}start the chat TUI`)
  ctx.print(entry("--profile [command]", "record an anonymous diagnostic profile"))
  ctx.print(
    entry(
      `--mode ${permissionModes().join("|")}`,
      `start the TUI in a permission mode (default: ${settings().mode ?? defaultPermissionMode})`,
    ),
  )
  for (const cli of listClis()) {
    if (cli.hidden) continue
    ctx.print(entry(cli.usage ?? cli.name, cli.describe))
  }
}

export function printCliHelp(cli: Cli, ctx: CliContext): void {
  ctx.print(`usage: ${appInfo.name} ${cli.usage ?? cli.name}`)

  const subs = listClis(cli.name).filter((sub) => !sub.hidden)
  if (subs.length === 0) return

  ctx.print("")
  for (const sub of subs) {
    ctx.print(entry(`${cli.name} ${sub.name}`, sub.describe))
  }
}
