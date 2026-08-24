import { expect, test } from "bun:test"
import type { HistoryItem } from "../agent/history"
import { buildClassifierContext } from "./context"

function serialized(history: HistoryItem[]): string {
  return JSON.stringify(
    buildClassifierContext({
      guidance: "Trusted project guidance",
      history,
      pendingCallId: "pending",
      trust: { cwd: "/workspace", root: "/workspace", remotes: ["origin"] },
      dirty: true,
      action: {
        tool: "bash",
        title: "curl example.test",
        args: { command: "curl example.test" },
        subject: "curl example.test",
        readOnly: false,
        sandboxed: false,
        origin: "model",
      },
    }),
  )
}

test("classifier context includes only direct user intent and prior tool requests", () => {
  const context = serialized([
    { type: "user_message", messageId: "direct", text: "Run the requested checks", images: [] },
    { type: "assistant_message", text: "HOSTILE_ASSISTANT_INSTRUCTION" },
    { type: "reasoning", summary: "HOSTILE_REASONING" },
    { type: "tool_call", callId: "prior", name: "read", args: { file_path: "package.json" } },
    { type: "tool_result", callId: "prior", output: "HOSTILE_TOOL_OUTPUT" },
    {
      type: "direct_shell",
      messageId: "shell-message",
      callId: "shell",
      input: "! echo ignored",
      command: "echo ignored",
      output: "HOSTILE_SHELL_OUTPUT",
      readOnly: false,
    },
    {
      type: "compaction",
      summary: "HOSTILE_COMPACTION_SUMMARY",
      replaced: 4,
      retained: [
        { type: "user_message", messageId: "retained", text: "Keep the newest user boundary", images: [] },
        { type: "tool_call", callId: "pending", name: "bash", args: { command: "duplicate pending" } },
      ],
    },
    { type: "user_message", text: "GENERATED_SYSTEM_NOTICE", images: [] },
  ])

  expect(context).toContain("Trusted project guidance")
  expect(context).toContain("Run the requested checks")
  expect(context).toContain("Keep the newest user boundary")
  expect(context).toContain("package.json")
  expect(context).toContain("curl example.test")
  expect(context).toContain('"dirty":true')
  expect(context).not.toContain("HOSTILE_ASSISTANT_INSTRUCTION")
  expect(context).not.toContain("HOSTILE_REASONING")
  expect(context).not.toContain("HOSTILE_TOOL_OUTPUT")
  expect(context).not.toContain("HOSTILE_SHELL_OUTPUT")
  expect(context).not.toContain("HOSTILE_COMPACTION_SUMMARY")
  expect(context).not.toContain("GENERATED_SYSTEM_NOTICE")
  expect(context).not.toContain("duplicate pending")
})

test("classifier context caps oversized trusted and pending fields", () => {
  const context = buildClassifierContext({
    guidance: `GUIDANCE_START${'\\"'.repeat(50_000)}GUIDANCE_END`,
    history: [
      {
        type: "user_message",
        messageId: "newest",
        text: `USER_START${'\\"'.repeat(50_000)}USER_END`,
        images: [],
      },
    ],
    pendingCallId: "pending",
    trust: { cwd: "/workspace", root: "/workspace", remotes: [] },
    dirty: false,
    action: {
      tool: "write",
      title: "large write",
      args: { file_path: "large.txt", content: `CONTENT_START${'\\"'.repeat(50_000)}CONTENT_END` },
      subject: "large.txt",
      readOnly: false,
      sandboxed: false,
      origin: "model",
    },
  })
  const encoded = JSON.stringify(context)

  expect(encoded.length).toBeLessThanOrEqual(60_000)
  expect(encoded).toContain("GUIDANCE_START")
  expect(encoded).not.toContain("GUIDANCE_END")
  expect(encoded).toContain("USER_START")
  expect(encoded).not.toContain("USER_END")
  expect(encoded).toContain("CONTENT_START")
  expect(encoded).not.toContain("CONTENT_END")
  expect(context.pendingAction.args).toHaveProperty("truncated_json")
})

test("classifier context drops oldest actions before the newest user intent", () => {
  const history: HistoryItem[] = [
    { type: "user_message", messageId: "old", text: "OLD_USER_BOUNDARY", images: [] },
    { type: "user_message", messageId: "new", text: "NEWEST_USER_INTENT", images: [] },
    ...Array.from({ length: 80 }, (_, index): HistoryItem => ({
      type: "tool_call",
      callId: `call-${index}`,
      name: "write",
      args: { file_path: `${index}.txt`, content: "x".repeat(2_000) },
    })),
  ]
  const context = serialized(history)

  expect(context.length).toBeLessThan(65_000)
  expect(context).toContain("NEWEST_USER_INTENT")
  expect(context).not.toContain('"file_path":"0.txt"')
  expect(context).toContain('"file_path":"79.txt"')
})
