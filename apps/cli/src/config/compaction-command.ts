import type { CommandContext } from "../commands/types"
import { decisions } from "../providers/decisions"
import type { CompactionSettings } from "./compaction"
import { saveSettings, settings } from "./settings"

export async function compactionConfigAvailable(): Promise<boolean> {
  return (
    settings().compaction.strategy === "jev" ||
    (await decisions.connections()).some((connection) => connection.provider.id === "typesafe")
  )
}

export async function configureCompaction(ctx: CommandContext): Promise<void> {
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure compaction while a turn is running")
  const connections = (await decisions.connections()).filter((connection) => connection.provider.id === "typesafe")
  const current = settings().compaction
  const selected = await ctx.select<CompactionSettings>({
    options: [
      {
        label: "Summary compaction",
        detail: "use the harness model (default)",
        active: current.strategy === "summary",
        value: { strategy: "summary" },
      },
      ...connections.map(({ profile }) => ({
        label: `Jev · ${profile.name}`,
        detail: "send text history to TypeSafe; prune stale tool calls and results, fall back to summary when needed",
        active: current.strategy === "jev" && current.profile === profile.id,
        value: { strategy: "jev" as const, profile: profile.id },
      })),
    ],
  })
  if (!selected) return
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure compaction while a turn is running")
  if (
    selected.strategy === "jev" &&
    !(await decisions.connections()).some(
      (entry) => entry.provider.id === "typesafe" && entry.profile.id === selected.profile,
    )
  ) {
    throw new Error("TypeSafe profile is no longer connected")
  }
  await saveSettings({ compaction: selected })
  ctx.print(`compaction · ${settings().compaction.strategy} (effective setting)`)
}
