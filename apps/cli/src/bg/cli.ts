import { appInfo } from "../app-info"
import { printCliHelp } from "../cli/help"
import { registerCli } from "../cli/registry"
import type { Cli, CliContext } from "../cli/types"
import { settings } from "../config/settings"
import { formatRelative } from "../lib/time"
import { getUi } from "../ui/registry"
import { stopBackgroundWorker, takeOverBackgroundSession } from "./attach"
import { clearBackgroundSessions, findBackgroundSession, listBackgroundSessions, type BgView } from "./state"
import { runBackgroundWorker } from "./worker"

function statusLabel(view: BgView): string {
  return view.effective.replaceAll("_", " ")
}

function trailing(view: BgView): string {
  if (view.effective === "died") return `log: ${view.state.log}`
  const note = view.state.detail ?? view.state.activity ?? ""
  const version = view.state.appVersion === appInfo.version ? "" : ` · from ${appInfo.name} ${view.state.appVersion}`
  return `${note}${version}`
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

async function printBackgroundSessions(ctx: CliContext): Promise<void> {
  const views = await listBackgroundSessions()
  if (views.length === 0) {
    ctx.print("no background sessions")
    return
  }
  for (const view of views) {
    const columns = [
      view.state.sessionId.slice(0, 8),
      statusLabel(view).padEnd(11),
      clip(view.state.title ?? "untitled", 32).padEnd(32),
      formatRelative(view.state.updatedAt).padEnd(9),
      trailing(view),
    ]
    ctx.print(columns.join("  ").trimEnd())
  }
}

function requireId(args: string[], usage: string): string {
  const id = args[0]
  if (!id || args.length > 1) throw new Error(`usage: ${appInfo.name} ${usage}`)
  return id
}

const bgCli: Cli = {
  name: "bg",
  describe: "manage sessions running in the background",
  usage: "bg [command]",
  async run(args, ctx) {
    const first = args[0]
    if (first === "--help" || first === "-h" || first === "help") {
      printCliHelp(bgCli, ctx)
      return
    }
    if (args.length > 0) throw new Error(`usage: ${appInfo.name} bg [list|attach <id>|stop <id>|clear [id]]`)
    await printBackgroundSessions(ctx)
  },
}

const listCli: Cli = {
  name: "list",
  describe: "list background sessions",
  usage: "bg list",
  async run(_args, ctx) {
    await printBackgroundSessions(ctx)
  },
}

const attachCli: Cli = {
  name: "attach",
  describe: "take a background session back into the TUI",
  usage: "bg attach <session-id>",
  async run(args) {
    const id = requireId(args, "bg attach <session-id>")
    const uiId = settings().ui ?? "tui"
    const ui = getUi(uiId)
    if (!ui) throw new Error(`unknown ui: ${uiId}`)
    const takeover = await takeOverBackgroundSession(id)
    try {
      await ui.start({
        resume: takeover.summary,
        writer: takeover.writer,
        continueWork: takeover.continueWork,
        retryPendingTools: takeover.retryPendingTools,
      })
    } finally {
      takeover.writer.close()
    }
  },
}

const stopCli: Cli = {
  name: "stop",
  describe: "stop a background session",
  usage: "bg stop <session-id>",
  async run(args, ctx) {
    const id = requireId(args, "bg stop <session-id>")
    const view = await findBackgroundSession(id)
    if (!view) throw new Error(`no background session matches ${id}`)
    const short = view.state.sessionId.slice(0, 8)
    const outcome = await stopBackgroundWorker(view)
    switch (outcome) {
      case "not_running":
        ctx.print(`session ${short} is not running (${statusLabel(view)})`)
        return
      case "timeout":
        ctx.error(`session ${short} did not acknowledge the stop request; log: ${view.state.log}`)
        return
      case "stopped":
        ctx.print(`stopped ${short}; resume it with "${appInfo.name} bg attach ${short}"`)
        return
    }
  },
}

const clearCli: Cli = {
  name: "clear",
  describe: "remove finished background entries",
  usage: "bg clear [session-id]",
  async run(args, ctx) {
    if (args.length > 1) throw new Error(`usage: ${appInfo.name} bg clear [session-id]`)
    const removed = await clearBackgroundSessions(args[0])
    if (removed.length === 0) {
      ctx.print("nothing to clear")
      return
    }
    for (const id of removed) ctx.print(`cleared ${id.slice(0, 8)}`)
  },
}

const workerCli: Cli = {
  name: "worker",
  describe: "run the background worker for a session",
  usage: "bg worker <session-id> <worker-id>",
  hidden: true,
  async run(args, ctx) {
    await runBackgroundWorker(args[0], args[1], ctx)
  },
}

export function registerBgClis(): void {
  registerCli(bgCli)
  registerCli(listCli, "bg")
  registerCli(attachCli, "bg")
  registerCli(stopCli, "bg")
  registerCli(clearCli, "bg")
  registerCli(workerCli, "bg")
}
