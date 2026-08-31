import { appInfo } from "../../app-info"
import { resumeSession } from "../../agent/session/compose"
import { stopBackgroundWorker, takeOverBackgroundSession } from "../../bg/attach"
import type { DetachOutcome } from "../../bg/launch"
import { clearBackgroundSessions, listBackgroundSessions, type BgView } from "../../bg/state"
import type { Command, CommandContext } from "../../commands/types"
import { usageDir } from "../../config/paths"
import { formatRelative } from "../../lib/time"
import { getProvider } from "../../providers/registry"
import { parseUsageActivityView, type UsageActivityView } from "../../usage/activity"
import { flushProviderUsage } from "../../usage/recorder"
import { readProviderUsageSummary, type ProviderUsageSummary } from "../../usage/summary"
import type { PluginContext } from "../types"

interface TuiCommandActions {
  agents(): void
  config(): void
  usage(summary: ProviderUsageSummary, view: UsageActivityView, provider?: string): void
  terminal(): string[]
  quit(): void
  detach(): Promise<DetachOutcome>
}

let actions: TuiCommandActions | undefined

export function setTuiCommandActions(next: TuiCommandActions): () => void {
  actions = next
  return () => {
    if (actions === next) actions = undefined
  }
}

const terminalCommand: Command = {
  name: "terminal",
  describe: "show detected terminal capabilities",
  async run(_args, ctx) {
    if (!actions) throw new Error("tui is not running")
    for (const line of actions.terminal()) ctx.print(line)
  },
}

const configCommand: Command = {
  name: "config",
  describe: "configure persistent display preferences",
  async run() {
    if (!actions) throw new Error("tui is not running")
    actions.config()
  },
}

interface UsageCommandArguments {
  view: UsageActivityView
  provider?: string
}

export function parseUsageCommandArguments(args: string[]): UsageCommandArguments {
  if (args.length > 2) throw new Error("usage: /usage [daily|weekly|cumulative] [provider]")

  let view: UsageActivityView = "daily"
  let viewSelected = false
  let provider: string | undefined
  for (const argument of args) {
    const parsedView = parseUsageActivityView(argument)
    if (parsedView) {
      if (viewSelected) throw new Error("usage: /usage [daily|weekly|cumulative] [provider]")
      view = parsedView
      viewSelected = true
      continue
    }
    if (provider) throw new Error("usage: /usage [daily|weekly|cumulative] [provider]")
    provider = argument
  }
  return provider === undefined ? { view } : { view, provider }
}

const usageCommand: Command = {
  name: "usage",
  describe: "show daily, weekly, or cumulative token activity",
  async run(args, ctx) {
    if (!actions) throw new Error("tui is not running")
    const parsed = parseUsageCommandArguments(args)
    const provider = parsed.provider === undefined ? undefined : getProvider(parsed.provider)
    if (parsed.provider !== undefined && !provider) throw new Error(`unknown provider: ${parsed.provider}`)

    await flushProviderUsage()
    const summary = await readProviderUsageSummary(
      usageDir(),
      ctx.session.id,
      provider === undefined ? {} : { provider: provider.id },
    )
    actions.usage(summary, parsed.view, provider?.name)
  },
}

const agentsCommand: Command = {
  name: "agents",
  aliases: ["jobs"],
  describe: "view running agents and background jobs",
  async run() {
    if (!actions) throw new Error("tui is not running")
    actions.agents()
  },
}

async function exitTui(): Promise<void> {
  if (!actions) throw new Error("tui is not running")
  actions.quit()
}

const quitCommand: Command = {
  name: "quit",
  aliases: ["exit"],
  describe: `exit ${appInfo.name}`,
  run: exitTui,
}

type BgAction = "attach" | "stop" | "log" | "remove"

async function attachHere(ctx: CommandContext, view: BgView): Promise<void> {
  if (ctx.session.currentState !== "idle" || ctx.session.hasPendingAsyncWork()) {
    throw new Error("finish or interrupt the current work before attaching another session")
  }
  ctx.busy("Attaching session")
  try {
    const takeover = await takeOverBackgroundSession(view.state.sessionId)
    for (const notice of await resumeSession(ctx.session, takeover.summary, {
      deferGoalResume: takeover.retryPendingTools,
    }))
      ctx.print(notice)
    if (takeover.retryPendingTools && !ctx.session.retryPendingTools()) {
      throw new Error("the pending background request could not be restored")
    }
    if (!takeover.retryPendingTools && takeover.continueWork) ctx.session.continueTurn()
  } finally {
    ctx.busy()
  }
}

async function manageBackgroundSessions(ctx: CommandContext): Promise<void> {
  const views = await listBackgroundSessions()
  if (views.length === 0) {
    ctx.print("no background sessions")
    return
  }
  const view = await ctx.select({
    search: "filter background sessions",
    options: views.map((entry) => ({
      label: entry.state.title ?? "untitled",
      detail: formatRelative(entry.state.updatedAt),
      note: `${entry.effective.replaceAll("_", " ")}${entry.state.activity ? ` · ${entry.state.activity}` : ""}`,
      value: entry,
    })),
  })
  if (!view) return
  const short = view.state.sessionId.slice(0, 8)
  const action = await ctx.select<BgAction>({
    options: [
      { label: "Attach here", detail: `take ${short} over into this TUI`, value: "attach" },
      { label: "Stop", detail: "stop the background worker", value: "stop" },
      { label: "Show log path", detail: view.state.log, value: "log" },
      { label: "Remove entry", detail: "clear this entry once it is not running", value: "remove" },
    ],
  })
  switch (action) {
    case undefined:
      return
    case "attach":
      if (view.state.sessionId === ctx.session.id) throw new Error("this session is already open here")
      await attachHere(ctx, view)
      return
    case "stop": {
      const outcome = await stopBackgroundWorker(view)
      if (outcome === "not_running") ctx.print(`session ${short} is not running`)
      if (outcome === "timeout") throw new Error(`session ${short} did not acknowledge the stop request`)
      if (outcome === "stopped") ctx.print(`stopped ${short}`)
      return
    }
    case "log":
      ctx.print(view.state.log)
      return
    case "remove":
      await clearBackgroundSessions(view.state.sessionId)
      ctx.print(`cleared ${short}`)
      return
  }
}

const backgroundCommand: Command = {
  name: "bg",
  aliases: ["background"],
  describe: "run this session in the background · /bg list to manage",
  async run(args, ctx) {
    if (args[0] === "list" && args.length === 1) {
      await manageBackgroundSessions(ctx)
      return
    }
    if (args.length > 0) throw new Error("usage: /bg or /bg list")
    if (!actions) throw new Error("tui is not running")
    ctx.busy("Backgrounding session")
    let outcome: DetachOutcome
    try {
      outcome = await actions.detach()
    } finally {
      ctx.busy()
    }
    if (outcome.status === "blocked") throw new Error(outcome.reason)
    if (outcome.status === "failed") throw new Error(`backgrounding failed: ${outcome.reason}`)
  },
}

export function registerTuiCommands(ctx: PluginContext): void {
  ctx.registerCommand(agentsCommand)
  ctx.registerCommand(backgroundCommand)
  ctx.registerCommand(configCommand)
  ctx.registerCommand(terminalCommand)
  ctx.registerCommand(usageCommand)
  ctx.registerCommand(quitCommand)
}
