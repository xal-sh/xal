import { expect, test } from "bun:test"
import type { CompactionItem } from "../agent/history"
import { parseRecord } from "./records"

function itemRecord(item: unknown): string {
  return JSON.stringify({ type: "item", item })
}

test("parses legacy and user-only compaction records without changing their shape", () => {
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

  expect(parseRecord(itemRecord(legacy))).toEqual({ type: "item", item: legacy })
  expect(parseRecord(itemRecord(current))).toEqual({ type: "item", item: current })
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
