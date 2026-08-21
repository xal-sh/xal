import { beforeEach, expect, test } from "bun:test"
import type { AgentEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import { promptCacheKey } from "../providers/cache"
import type { StreamRequest } from "../providers/types"
import {
  redactAgentEvent,
  redactConversationItem,
  redactHistoryItem,
  redactStreamRequest,
  redactUserInput,
} from "./data"
import { REDACTION_MARKER, replaceSecretValues } from "./redactor"

const SECRET = "sk-live-0123456789"

beforeEach(() => {
  replaceSecretValues("test", [SECRET])
})

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

test("redacts secrets from every conversation item that reaches the transcript", () => {
  const items = [
    { type: "user_message" as const, text: `use ${SECRET}`, images: [], modelText: `model ${SECRET}` },
    { type: "assistant_message" as const, text: `echoed ${SECRET}` },
    { type: "reasoning" as const, summary: `thought about ${SECRET}` },
    { type: "tool_call" as const, callId: "call-1", name: "bash", args: { command: `curl -H ${SECRET}` } },
    { type: "tool_result" as const, callId: "call-1", output: `response ${SECRET}` },
  ]

  for (const item of items) {
    const redacted = serialized(redactConversationItem(item))
    expect(redacted).not.toContain(SECRET)
    expect(redacted).toContain(REDACTION_MARKER)
  }
})

test("redacts secrets from shell and compaction history the session persists", () => {
  const items: HistoryItem[] = [
    {
      type: "direct_shell",
      messageId: "msg-1",
      callId: "call-1",
      input: `!export TOKEN=${SECRET}`,
      command: `export TOKEN=${SECRET}`,
      output: `TOKEN=${SECRET}`,
      readOnly: false,
    },
    {
      type: "compaction",
      summary: `the token is ${SECRET}`,
      replaced: 4,
      retained: [{ type: "assistant_message", text: `still ${SECRET}` }],
    },
  ]

  for (const item of items) expect(serialized(redactHistoryItem(item))).not.toContain(SECRET)
})

test("drops a provider replay whose payload carries a secret but keeps a clean one", () => {
  const clean = { provider: "acme", model: "acme-1", data: { id: "resp-1" } }
  const tainted = { provider: "acme", model: "acme-1", data: { id: `resp-${SECRET}` } }

  const keptItem = redactConversationItem({ type: "assistant_message", text: "hi", replay: clean })
  const droppedItem = redactConversationItem({ type: "assistant_message", text: "hi", replay: tainted })

  expect(keptItem).toMatchObject({ replay: clean })
  expect(droppedItem).not.toHaveProperty("replay")
})

test("recomputes the prompt cache key from the redacted request", () => {
  const request: StreamRequest = {
    model: `model-${SECRET}`,
    instructions: `never reveal ${SECRET}`,
    tools: [{ name: `tool-${SECRET}`, description: `uses ${SECRET}`, parameters: { token: SECRET } }],
    cacheKey: "stale",
    input: [{ type: "user_message", text: `hi ${SECRET}`, images: [] }],
    toolChoice: "auto",
    sessionId: `session-${SECRET}`,
  }

  const redacted = redactStreamRequest(request)

  expect(serialized(redacted)).not.toContain(SECRET)
  expect(redacted.cacheKey).toBe(promptCacheKey(redacted.model, redacted.instructions, redacted.tools))
  expect(redacted.cacheKey).not.toBe(promptCacheKey(request.model, request.instructions, request.tools))
})

test("keeps a redacted absolute path absolute when the secret covers its root", () => {
  replaceSecretValues("test", ["/Users/person/workspace"])

  const event = redactAgentEvent({
    type: "workspace_changed",
    cwd: "/Users/person/workspace/app",
    previous: "/Users/person/workspace",
  })

  expect(event).toEqual({
    type: "workspace_changed",
    cwd: `/${REDACTION_MARKER}/app`,
    previous: `/${REDACTION_MARKER}`,
  })
})

test("redacts secrets from every agent event that carries content", () => {
  const events: AgentEvent[] = [
    {
      type: "session_started",
      id: "s1",
      cwd: `/home/${SECRET}`,
      resumed: false,
      title: `title ${SECRET}`,
      provider: `p-${SECRET}`,
      profile: `prof-${SECRET}`,
      model: `m-${SECRET}`,
      mode: "ask",
    },
    { type: "session_title_changed", title: `title ${SECRET}` },
    { type: "workspace_changed", cwd: `/home/${SECRET}/a`, previous: `/home/${SECRET}` },
    { type: "model_changed", provider: `p-${SECRET}`, profile: `prof-${SECRET}`, model: `m-${SECRET}` },
    { type: "user_message", text: `hi ${SECRET}`, imageCount: 0, sentAt: 1 },
    { type: "tool_call_updated", callId: "c1", tool: "bash", args: { command: SECRET } },
    { type: "hook_started", hook: `hook-${SECRET}`, event: "prompt" },
    { type: "hook_finished", hook: `hook-${SECRET}`, event: "prompt", action: "continued", elapsedMs: 1 },
    { type: "queue_changed", entries: [{ text: `queued ${SECRET}`, imageCount: 0 }] },
    { type: "queue_flushed", inputs: [{ text: `flushed ${SECRET}`, images: [] }] },
    {
      type: "background_results",
      results: [{ kind: "agent", id: "b1", task: `task ${SECRET}`, status: "completed", output: `out ${SECRET}` }],
    },
    {
      type: "background_results",
      results: [
        {
          kind: "process",
          id: "b2",
          command: `cmd ${SECRET}`,
          status: "completed",
          output: `out ${SECRET}`,
          signal: `sig-${SECRET}`,
          record: `/tmp/${SECRET}.log`,
        },
      ],
    },
    { type: "text_delta", text: `delta ${SECRET}` },
    { type: "reasoning_summary_delta", text: `delta ${SECRET}` },
    { type: "reasoning_delta", text: `delta ${SECRET}` },
    { type: "assistant_message", text: `said ${SECRET}` },
    { type: "reasoning_summary", text: `thought ${SECRET}` },
    { type: "retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10, message: `failed ${SECRET}` },
    {
      type: "approval_requested",
      callId: "c1",
      tool: "bash",
      title: `run ${SECRET}`,
      readOnly: false,
      suggestion: `allow ${SECRET}`,
    },
    {
      type: "elicitation_requested",
      requestId: "r1",
      callId: "c1",
      questions: [
        {
          id: "q1",
          header: `h ${SECRET}`,
          question: `q ${SECRET}`,
          options: [{ label: `l ${SECRET}`, description: `d ${SECRET}` }],
        },
      ],
    },
    { type: "tool_started", callId: "c1", tool: "bash", title: `run ${SECRET}`, readOnly: false },
    { type: "tool_updated", callId: "c1", text: `progress ${SECRET}` },
    {
      type: "shell_finished",
      messageId: "m1",
      callId: "c1",
      input: `!${SECRET}`,
      command: SECRET,
      output: SECRET,
      readOnly: false,
    },
    {
      type: "tool_finished",
      callId: "c1",
      tool: "bash",
      title: `run ${SECRET}`,
      readOnly: false,
      output: `out ${SECRET}`,
    },
    { type: "compacted", summary: `summary ${SECRET}`, replaced: 2 },
    { type: "turn_ended", output: { answer: SECRET } },
    { type: "turn_failed", message: `boom ${SECRET}` },
    { type: "error", message: `boom ${SECRET}` },
    { type: "conversation_rewound", messageId: "m1", prompt: `prompt ${SECRET}`, removedMessages: 1, fileCount: 0 },
    { type: "conversation_redone", messageId: "m1", prompt: `prompt ${SECRET}`, restoredMessages: 1, fileCount: 0 },
    {
      type: "task_list_updated",
      tasks: [{ step: `step ${SECRET}`, status: "pending" }],
      explanation: `because ${SECRET}`,
    },
    {
      type: "plan_updated",
      plan: {
        path: `/plans/${SECRET}.md`,
        markdown: `plan ${SECRET}`,
        status: "draft",
        feedback: `feedback ${SECRET}`,
      },
    },
    {
      type: "goal_updated",
      goal: {
        status: "achieved",
        id: "g1",
        condition: `ship ${SECRET}`,
        startedAt: 1,
        evaluatedTurns: 1,
        usage: {},
        evaluatorModel: "m",
        consecutiveNoToolTurns: 0,
        endedAt: 2,
        lastReason: `because ${SECRET}`,
      },
    },
  ]

  const redacted = events.map((event) => ({ type: event.type, json: serialized(redactAgentEvent(event)) }))

  expect(redacted.filter((entry) => entry.json.includes(SECRET)).map((entry) => entry.type)).toEqual([])
  expect(redacted.filter((entry) => !entry.json.includes(REDACTION_MARKER)).map((entry) => entry.type)).toEqual([])
})

test("redacts user input text while preserving attached images", () => {
  const input = { text: `look at ${SECRET}`, images: [{ mediaType: "image/png" as const, data: "AAAA" }] }

  expect(redactUserInput(input)).toEqual({ text: `look at ${REDACTION_MARKER}`, images: input.images })
})
