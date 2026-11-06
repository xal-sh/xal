import { asNumber, asString } from "../../lib/json"
import type { ConversationItem, ToolCallItem } from "../../providers/types"
import { toolFailed } from "../../tools/output"

const STALE_READ_OUTPUT =
  "[Removed during compaction: a later read or write of this file supersedes this output. Read the file again if needed.]"

export function pruneStaleReads(items: ConversationItem[]): { items: ConversationItem[]; pruned: number } {
  const calls = new Map<string, ToolCallItem>()
  for (const item of items) if (item.type === "tool_call") calls.set(item.callId, item)
  const fullyKnown = new Set<string>()
  const rangesKnown = new Set<string>()
  const stale = new Set<number>()
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.type !== "tool_result" || toolFailed(item.output)) continue
    const call = calls.get(item.callId)
    const path = call ? asString(call.args.file_path) : undefined
    if (!call || !path) continue
    if (call.name === "write") {
      fullyKnown.add(path)
      continue
    }
    if (call.name !== "read") continue
    const offset = asNumber(call.args.offset)
    const limit = asNumber(call.args.limit)
    const range = `${path}\u0000${offset ?? ""}\u0000${limit ?? ""}`
    if ((fullyKnown.has(path) || rangesKnown.has(range)) && item.output.length > STALE_READ_OUTPUT.length) {
      stale.add(index)
    }
    if (offset === undefined && limit === undefined) fullyKnown.add(path)
    rangesKnown.add(range)
  }
  return {
    items: items.map((item, index) =>
      stale.has(index) && item.type === "tool_result" ? { ...item, output: STALE_READ_OUTPUT } : item,
    ),
    pruned: stale.size,
  }
}
