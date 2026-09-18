import { isRecord } from "../lib/json"

export type CompactionSettings = { strategy: "summary" } | { strategy: "jev"; profile: string }

export function parseCompactionSettings(raw: unknown): CompactionSettings {
  if (raw === undefined) return { strategy: "summary" }
  if (!isRecord(raw)) throw new Error("compaction must be an object")
  if (Object.keys(raw).some((key) => key !== "strategy" && key !== "profile"))
    throw new Error("unsupported compaction setting")
  if (raw.strategy === "summary") return { strategy: "summary" }
  if (raw.strategy === "jev" && typeof raw.profile === "string" && raw.profile.trim()) {
    return { strategy: "jev", profile: raw.profile }
  }
  throw new Error("compaction requires strategy summary or jev with a connected profile ID")
}
