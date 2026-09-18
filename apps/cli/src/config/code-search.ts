import { isRecord } from "../lib/json"

export type CodeSearchSettings = { strategy: "off" } | { strategy: "jev"; profile: string }

export function parseCodeSearchSettings(raw: unknown): CodeSearchSettings {
  if (raw === undefined) return { strategy: "off" }
  if (!isRecord(raw)) throw new Error("codeSearch must be an object")
  if (Object.keys(raw).some((key) => key !== "strategy" && key !== "profile"))
    throw new Error("unsupported codeSearch setting")
  if (raw.strategy === "off") return { strategy: "off" }
  if (raw.strategy === "jev" && typeof raw.profile === "string" && raw.profile.trim()) {
    return { strategy: "jev", profile: raw.profile }
  }
  throw new Error("codeSearch requires strategy off or jev with a connected profile ID")
}
