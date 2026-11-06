import { expect, test } from "bun:test"
import type { ConversationItem } from "../../providers/types"
import { pruneStaleReads } from "./stale-reads"

function call(callId: string, name: string, args: Record<string, string | number>, output: string): ConversationItem[] {
  return [
    { type: "tool_call", callId, name, args },
    { type: "tool_result", callId, output },
  ]
}

test("removes only reads that a later full read, matching range, or write supersedes", () => {
  const body = "x".repeat(400)
  const items = [
    ...call("full-1", "read", { file_path: "a.ts" }, `old a ${body}`),
    ...call("range-1", "read", { file_path: "b.ts", offset: 10, limit: 5 }, `old b range ${body}`),
    ...call("range-2", "read", { file_path: "b.ts", offset: 20, limit: 5 }, `other b range ${body}`),
    ...call("written", "read", { file_path: "c.ts" }, `old c ${body}`),
    ...call("failed", "write", { file_path: "a.ts" }, "Tool failed: denied"),
    ...call("write-c", "write", { file_path: "c.ts", content: "new" }, "Created c.ts (1 lines)"),
    ...call("range-3", "read", { file_path: "b.ts", offset: 10, limit: 5 }, `new b range ${body}`),
    ...call("full-2", "read", { file_path: "a.ts" }, `new a ${body}`),
  ]

  const result = pruneStaleReads(items)

  expect(result.pruned).toBe(3)
  const outputs = result.items.flatMap((item) => (item.type === "tool_result" ? [item.output.slice(0, 13)] : []))
  expect(outputs).toEqual([
    "[Removed duri",
    "[Removed duri",
    "other b range",
    "[Removed duri",
    "Tool failed: ",
    "Created c.ts ",
    "new b range x",
    "new a xxxxxxx",
  ])
  expect(pruneStaleReads(result.items).pruned).toBe(0)
})
