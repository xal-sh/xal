import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConversationItem } from "../../providers/types"
import { replaceSecretValues } from "../../secrets/redactor"
import { offloadToolOutputs } from "./tool-output-compaction"

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xal-tool-offload-"))
})
afterEach(async () => {
  replaceSecretValues("tool-output-compaction-test", [])
  await rm(directory, { recursive: true, force: true })
})

function exchange(callId: string, name: string, output = "content\n".repeat(1000)): ConversationItem[] {
  return [
    { type: "tool_call", callId, name, args: {} },
    { type: "tool_result", callId, output },
  ]
}

function recentExchanges(): ConversationItem[] {
  return Array.from({ length: 12 }, (_, index) => exchange(`recent-${index}`, "read")).flat()
}

test("archives exact delivered text privately, preserves recovery notices, and removes read coverage", async () => {
  const secret = `offload-secret-${crypto.randomUUID()}`
  replaceSecretValues("tool-output-compaction-test", [secret])
  const output = `${"界🙂\n".repeat(1000)}${secret}\n[Output incomplete: capped]\nPartial output saved to: /original/log`
  const items: ConversationItem[] = [
    { type: "user_message", text: "Keep the requirements", images: [] },
    { type: "reasoning", summary: "Keep the reasoning" },
    { type: "assistant_message", text: "Keep the decision" },
    { type: "tool_call", callId: "old", name: "read", args: { file_path: "source.ts" } },
    {
      type: "tool_result",
      callId: "old",
      output,
      read: { path: "/source.ts", contentHash: "hash", offset: 1, limit: 1000, truncated: false },
    },
    ...recentExchanges(),
  ]
  const original = structuredClone(items)
  const result = await offloadToolOutputs(items, directory, new AbortController().signal)
  expect(result.offloaded).toBe(1)
  expect(items).toEqual(original)
  expect(result.items.slice(0, 4)).toEqual(items.slice(0, 4))
  expect(result.items.slice(5)).toEqual(items.slice(5))
  const archived = result.items[4]
  if (archived?.type !== "tool_result") throw new Error("missing archived result")
  expect(archived.callId).toBe("old")
  expect(archived.read).toBeUndefined()
  expect(archived.output).toContain("instead of rerunning")
  const path = /Archived tool result: (.+)/.exec(archived.output)?.[1]
  if (!path) throw new Error("missing archive path")
  expect(await readFile(path, "utf8")).toBe(output.replace(secret, "[REDACTED]"))
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
})

test("preserves the whole latest assistant call batch even when it exceeds the recent-call allowance", async () => {
  const batch = Array.from({ length: 16 }, (_, index) => exchange(`batch-${index}`, "grep"))
  const latest = [...batch.map((items) => items[0]!), ...batch.map((items) => items[1]!)]
  const result = await offloadToolOutputs(
    [...exchange("old", "glob"), ...latest],
    directory,
    new AbortController().signal,
  )
  expect(result.offloaded).toBe(1)
  expect(result.items.slice(2)).toEqual(latest)
})

test("pairs repeated call IDs by occurrence and keeps failures, images, small and instruction-bearing results", async () => {
  const image: ConversationItem = {
    type: "tool_result",
    callId: "image",
    output: "image text".repeat(1000),
    images: [{ mediaType: "image/png", data: "c2hvdA==" }],
  }
  const protectedItems: ConversationItem[] = [
    ...exchange("reused", "skill"),
    ...exchange("failure", "read", `Tool failed: ${"failure".repeat(1000)}`),
    ...exchange("unsaved", "read", `Tool completed, but its output could not be saved: ${"failure".repeat(1000)}`),
    ...exchange("small", "read", "x".repeat(4096)),
    ...exchange("shell", "bash"),
    ...exchange("memory", "memory"),
    ...exchange("mcp", "mcp__server__tool"),
    { type: "tool_call", callId: "image", name: "read", args: {} },
    image,
    { type: "tool_result", callId: "orphan", output: "unpaired".repeat(1000) },
  ]
  const eligible = ["read", "grep", "glob", "webfetch", "lsp"].flatMap((name) => exchange("reused", name))
  const items = [...protectedItems, ...eligible, ...recentExchanges()]
  const result = await offloadToolOutputs(items, directory, new AbortController().signal)
  expect(result.offloaded).toBe(5)
  expect(result.items.slice(0, protectedItems.length)).toEqual(protectedItems)
  expect(result.items.slice(-24)).toEqual(items.slice(-24))
  expect(await readdir(directory)).toHaveLength(5)
})

test("leaves inputs unchanged on archive failure or cancellation", async () => {
  const items = [...exchange("old", "read"), ...recentExchanges()]
  const original = structuredClone(items)
  await expect(offloadToolOutputs(items, import.meta.path, new AbortController().signal)).rejects.toThrow()
  expect(items).toEqual(original)
  const controller = new AbortController()
  controller.abort(new Error("stop offloading"))
  await expect(offloadToolOutputs(items, directory, controller.signal)).rejects.toThrow("stop offloading")
  expect(items).toEqual(original)
  expect(await readdir(directory)).toEqual([])
})
