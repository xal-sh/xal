import type { ConversationItem } from "../../providers/types"
import { redactText } from "../../secrets/redactor"
import { saveToolOutput, toolFailed } from "../../tools/output"

export async function offloadToolOutputs(
  items: ConversationItem[],
  directory: string,
  signal: AbortSignal,
): Promise<{ items: ConversationItem[]; offloaded: number }> {
  signal.throwIfAborted()
  const calls = new Map<string, { name: string; index: number }>()
  const results = new Map<number, { name: string; index: number }>()
  const callIndices: number[] = []
  let latestBatch = 0
  let receivedResults = false
  for (const [index, item] of items.entries()) {
    if (item.type === "tool_result") {
      receivedResults = true
      const call = calls.get(item.callId)
      if (call) results.set(index, call)
      calls.delete(item.callId)
    }
    if (item.type !== "tool_call") continue
    if (receivedResults) {
      latestBatch = index
      receivedResults = false
    }
    calls.set(item.callId, { name: item.name, index })
    callIndices.push(index)
  }
  const recentStart = callIndices.at(-12) ?? 0
  const eligible = new Set(["read", "grep", "glob", "webfetch", "lsp"])
  const retained: ConversationItem[] = []
  let offloaded = 0
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted()
    const call = results.get(index)
    if (
      item.type !== "tool_result" ||
      !call ||
      call.index >= recentStart ||
      call.index >= latestBatch ||
      !eligible.has(call.name) ||
      toolFailed(item.output) ||
      item.images?.length ||
      Buffer.byteLength(item.output) <= 4 * 1024
    ) {
      retained.push(item)
      continue
    }
    const path = await saveToolOutput(directory, redactText(item.output))
    signal.throwIfAborted()
    retained.push({
      ...item,
      output: `[Older tool output archived during automatic compaction. Retrieve this saved result instead of rerunning the tool.]\nArchived tool result: ${path}`,
      read: undefined,
    })
    offloaded += 1
  }
  return { items: retained, offloaded }
}
