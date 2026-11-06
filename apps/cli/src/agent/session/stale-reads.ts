import type { ConversationItem } from "../../providers/types"
import type { ReadCoverage } from "../../tools/read-coverage"

const STALE_READ_OUTPUT =
  "[Removed during compaction: a later read of the same file version covers this output. Read the file again if needed.]"

export function pruneStaleReads(items: ConversationItem[]): { items: ConversationItem[]; pruned: number } {
  const known = new Map<string, ReadCoverage[]>()
  const stale = new Set<number>()
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.type !== "tool_result" || !item.read) continue
    const read = item.read
    const key = `${read.path}\u0000${read.contentHash}`
    const ranges = known.get(key) ?? []
    if (
      item.output.length > STALE_READ_OUTPUT.length &&
      ranges.some((later) => later.offset <= read.offset && later.offset + later.limit >= read.offset + read.limit)
    ) {
      stale.add(index)
      continue
    }
    if (!read.truncated) {
      ranges.push(read)
      known.set(key, ranges)
    }
  }
  return {
    items: items.map((item, index) =>
      stale.has(index) && item.type === "tool_result" ? { ...item, output: STALE_READ_OUTPUT, read: undefined } : item,
    ),
    pruned: stale.size,
  }
}
