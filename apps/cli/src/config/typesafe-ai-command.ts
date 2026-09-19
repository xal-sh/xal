import type { CommandContext } from "../commands/types"
import { decisions } from "../providers/decisions"
import { saveSettings, settings } from "./settings"

function assertIdle(session: CommandContext["session"]): void {
  if (session.currentState !== "idle") throw new Error("cannot configure TypeSafe AI while a turn is running")
}

async function typesafeConnections() {
  return (await decisions.connections()).filter((connection) => connection.provider.id === "typesafe")
}

export async function toggleTypeSafeAI(
  session: CommandContext["session"],
  enabled: boolean,
): Promise<"saved" | "choose"> {
  assertIdle(session)
  if (!enabled) {
    await saveSettings({ typesafeAI: { enabled: false } })
    return "saved"
  }
  const connections = await typesafeConnections()
  if (connections.length === 0) throw new Error("connect TypeSafe with /connect first, then enable /config typesafe")
  const current = settings().typesafeAI.profile
  const profile =
    connections.find((connection) => connection.profile.id === current)?.profile.id ??
    (connections.length === 1 ? connections[0]!.profile.id : undefined)
  if (!profile) return "choose"
  assertIdle(session)
  await saveSettings({ typesafeAI: { enabled: true, profile } })
  return "saved"
}

export async function configureTypeSafeAI(ctx: CommandContext): Promise<void> {
  assertIdle(ctx.session)
  const selected = await ctx.select<boolean>({
    options: [
      {
        label: "On",
        detail:
          "Enable Jev compaction, read-ahead, and the classify tool. Sends redacted conversation text, tool names and inputs, search excerpts and candidate file paths, and model-supplied classification content to TypeSafe.",
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
  const report = (): void => {
    ctx.print(`TypeSafe AI · ${settings().typesafeAI.enabled ? "On" : "Off"} (effective setting)`)
  }
  if ((await toggleTypeSafeAI(ctx.session, selected)) === "saved") {
    report()
    return
  }
  const profile = await ctx.select<string>({
    options: (await typesafeConnections()).map(({ profile }) => ({
      label: profile.name,
      detail: "Use this connection for all TypeSafe AI features",
      value: profile.id,
    })),
  })
  if (!profile) return
  if (!(await typesafeConnections()).some((connection) => connection.profile.id === profile))
    throw new Error("TypeSafe profile is no longer connected")
  assertIdle(ctx.session)
  await saveSettings({ typesafeAI: { enabled: true, profile } })
  report()
}
