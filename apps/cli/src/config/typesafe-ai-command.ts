import type { CommandContext } from "../commands/types"
import { decisions } from "../providers/decisions"
import { saveSettings, settings } from "./settings"

export async function configureTypeSafeAI(ctx: CommandContext): Promise<void> {
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure TypeSafe AI while a turn is running")
  const selected = await ctx.select<boolean>({
    options: [
      {
        label: "On",
        detail:
          "Enable Jev compaction. Sends redacted conversation text and tool names and inputs to TypeSafe to prune stale tool history.",
        active: settings().typesafeAI.enabled,
        value: true,
      },
      {
        label: "Off",
        detail: "Disable TypeSafe AI features. Use normal summary compaction without TypeSafe requests (default).",
        active: !settings().typesafeAI.enabled,
        value: false,
      },
    ],
  })
  if (selected === undefined) return
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure TypeSafe AI while a turn is running")
  if (!selected) {
    await saveSettings({ typesafeAI: { enabled: false } })
    ctx.print(`TypeSafe AI · ${settings().typesafeAI.enabled ? "On" : "Off"} (effective setting)`)
    return
  }
  const connections = (await decisions.connections()).filter((connection) => connection.provider.id === "typesafe")
  if (connections.length === 0) throw new Error("connect TypeSafe with /connect first, then enable /config typesafe")
  const current = settings().typesafeAI.profile
  let profile = connections.find((connection) => connection.profile.id === current)?.profile.id
  if (!profile && connections.length === 1) profile = connections[0]!.profile.id
  if (!profile) {
    profile = await ctx.select<string>({
      options: connections.map(({ profile }) => ({
        label: profile.name,
        detail: "Use this connection for all TypeSafe AI features",
        value: profile.id,
      })),
    })
    if (!profile) return
  }
  if (
    !(await decisions.connections()).some(
      (connection) => connection.provider.id === "typesafe" && connection.profile.id === profile,
    )
  )
    throw new Error("TypeSafe profile is no longer connected")
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure TypeSafe AI while a turn is running")
  await saveSettings({ typesafeAI: { enabled: true, profile } })
  ctx.print(`TypeSafe AI · ${settings().typesafeAI.enabled ? "On" : "Off"} (effective setting)`)
}
