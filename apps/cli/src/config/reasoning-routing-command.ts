import type { CommandContext } from "../commands/types"
import { decisions } from "../providers/decisions"
import type { ReasoningRoutingSettings } from "./reasoning-routing"
import { saveSettings, settings } from "./settings"

export async function reasoningRoutingConfigAvailable(): Promise<boolean> {
  return (
    settings().reasoningRouting.strategy === "jev" ||
    (await decisions.connections()).some((connection) => connection.provider.id === "typesafe")
  )
}

export async function configureReasoningRouting(ctx: CommandContext): Promise<void> {
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure reasoning routing while a turn is running")
  const connections = (await decisions.connections()).filter((connection) => connection.provider.id === "typesafe")
  const current = settings().reasoningRouting
  const selected = await ctx.select<ReasoningRoutingSettings>({
    options: [
      {
        label: "Reasoning routing off",
        detail: "task agents inherit reasoning effort unless explicitly overridden (default)",
        active: current.strategy === "off",
        value: { strategy: "off" },
      },
      ...connections.map(({ profile }) => ({
        label: `Jev · ${profile.name}`,
        detail:
          "send task descriptions and shared context to TypeSafe; lower effort only for routine read-agent lookups",
        active: current.strategy === "jev" && current.profile === profile.id,
        value: { strategy: "jev" as const, profile: profile.id },
      })),
    ],
  })
  if (!selected) return
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure reasoning routing while a turn is running")
  if (
    selected.strategy === "jev" &&
    !(await decisions.connections()).some(
      (entry) => entry.provider.id === "typesafe" && entry.profile.id === selected.profile,
    )
  ) {
    throw new Error("TypeSafe profile is no longer connected")
  }
  await saveSettings({ reasoningRouting: selected })
  ctx.print(
    `reasoning routing · ${settings().reasoningRouting.strategy} (effective setting; applies when task agents start)`,
  )
}
