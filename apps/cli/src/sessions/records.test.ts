import { expect, test } from "bun:test"
import type { CompactionItem } from "../agent/history"
import type { ToolResultItem } from "../providers/types"
import { parseRecord } from "./records"
import type { SessionRecord } from "./types"

function itemRecord(item: unknown): string {
  return JSON.stringify({ type: "item", item })
}

test("round-trips prompt state and rejects malformed records", () => {
  const record = {
    type: "prompt_state",
    id: "project_instructions",
    state: { cwd: "/repo", paths: ["src/AGENTS.md"] },
  } satisfies SessionRecord
  expect(parseRecord(JSON.stringify(record))).toEqual(record)
  for (const invalid of [
    { ...record, id: "" },
    { ...record, state: null },
    { ...record, state: [] },
  ]) {
    expect(() => parseRecord(JSON.stringify(invalid))).toThrow("malformed session record")
  }
})

test("parses legacy, user-only, and pruned compaction records without changing their shape", () => {
  const legacy: CompactionItem = {
    type: "compaction",
    summary: "Legacy state",
    replaced: 4,
    tokensBefore: 1200,
    retained: [{ type: "assistant_message", text: "Legacy tail" }],
  }
  const current: CompactionItem = {
    type: "compaction",
    strategy: "user_messages_v1",
    summary: "Current state",
    replaced: 6,
    tokensBefore: 2400,
    tail: [
      { type: "tool_call", callId: "read", name: "read", args: { file_path: "a.ts" } },
      {
        type: "tool_result",
        callId: "read",
        output: "contents",
        read: { path: "/repo/a.ts", contentHash: "hash", offset: 1, limit: 1, truncated: false },
      },
    ],
    retained: [
      {
        type: "user_message",
        messageId: "11111111-1111-4111-8111-111111111111",
        text: "Continue",
        modelText: "Continue precisely",
        images: [],
      },
    ],
  }

  const pruned: CompactionItem = {
    type: "compaction",
    strategy: "stale_reads_v1",
    summary: "Removed 1 superseded file reads; retained conversation is otherwise unchanged.",
    replaced: 1,
    tokensBefore: 3600,
    retained: [
      { type: "tool_call", callId: "read", name: "read", args: { file_path: "a.ts" } },
      { type: "tool_result", callId: "read", output: "[Removed during compaction]" },
    ],
  }

  expect(parseRecord(itemRecord(legacy))).toEqual({ type: "item", item: legacy })
  expect(parseRecord(itemRecord(current))).toEqual({ type: "item", item: current })
  expect(parseRecord(itemRecord(pruned))).toEqual({ type: "item", item: pruned })
})

test("reads tool result images back in the shape they were written and rejects malformed ones", () => {
  const item: ToolResultItem = {
    type: "tool_result",
    callId: "read",
    output: "Image a.png",
    images: [{ mediaType: "image/png", data: "c2hvdA==" }],
  }
  expect(parseRecord(itemRecord(item))).toEqual({ type: "item", item })
  const malformed: unknown[] = [null, [{ mediaType: "image/gif", data: "c2hvdA==" }]]
  for (const images of malformed) {
    expect(() => parseRecord(itemRecord({ ...item, images }))).toThrow("malformed session record")
  }
})

test("rejects malformed persisted read coverage rather than treating it as a complete read", () => {
  for (const read of [null, {}, { path: "/a", contentHash: "hash", offset: 1, limit: -1, truncated: false }]) {
    expect(() => parseRecord(itemRecord({ type: "tool_result", callId: "read", output: "body", read }))).toThrow(
      "malformed session record",
    )
  }
})

test("rejects unknown strategies and invalid user-only retained items", () => {
  const retained = {
    type: "user_message",
    messageId: "11111111-1111-4111-8111-111111111111",
    text: "Continue",
    images: [],
  }
  const invalid = [
    { strategy: "future", retained: [retained] },
    { strategy: "user_messages_v1", retained: [retained], tail: {} },
    { strategy: "user_messages_v1", retained: [retained], tail: [{ type: "tool_result", callId: "read" }] },
    { strategy: "user_messages_v1", retained: [{ type: "assistant_message", text: "No" }] },
    { strategy: "user_messages_v1", retained: [{ ...retained, messageId: undefined }] },
    {
      strategy: "user_messages_v1",
      retained: [{ ...retained, images: [{ mediaType: "image/png", data: "AAAA" }] }],
    },
  ]

  for (const value of invalid) {
    expect(() => parseRecord(itemRecord({ type: "compaction", summary: "State", replaced: 1, ...value }))).toThrow(
      "malformed session record",
    )
  }
})
