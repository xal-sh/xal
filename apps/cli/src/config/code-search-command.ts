import type { CommandContext } from "../commands/types"
import { decisions } from "../providers/decisions"
import type { CodeSearchSettings } from "./code-search"
import { saveSettings, settings } from "./settings"

export async function codeSearchConfigAvailable(): Promise<boolean> {
  return (
    settings().codeSearch.strategy === "jev" ||
    (await decisions.connections()).some((connection) => connection.provider.id === "typesafe")
  )
}

export async function configureCodeSearch(ctx: CommandContext): Promise<void> {
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure code search while a turn is running")
  const connections = (await decisions.connections()).filter((connection) => connection.provider.id === "typesafe")
  const current = settings().codeSearch
  const selected = await ctx.select<CodeSearchSettings>({
    options: [
      {
        label: "Code search off",
        detail: "use grep, glob, read, and LSP (default)",
        active: current.strategy === "off",
        value: { strategy: "off" },
      },
      ...connections.map(({ profile }) => ({
        label: `Jev · ${profile.name}`,
        detail: "send search queries, file paths, and source excerpts to TypeSafe for relevance ranking",
        active: current.strategy === "jev" && current.profile === profile.id,
        value: { strategy: "jev" as const, profile: profile.id },
      })),
    ],
  })
  if (!selected) return
  if (ctx.session.currentState !== "idle") throw new Error("cannot configure code search while a turn is running")
  if (
    selected.strategy === "jev" &&
    !(await decisions.connections()).some(
      (entry) => entry.provider.id === "typesafe" && entry.profile.id === selected.profile,
    )
  ) {
    throw new Error("TypeSafe profile is no longer connected")
  }
  await saveSettings({ codeSearch: selected })
  ctx.print(`code search · ${settings().codeSearch.strategy} (effective setting)`)
}
