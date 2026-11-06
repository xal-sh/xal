import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamRequest, ThinkingEffort } from "../../providers/types"

interface CapturedRequest {
  profileId: string
  path: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []

mock.module("./auth", () => ({
  async authorizedFetch(profileId: string, path: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ profileId, path, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked xAI response")
    return response
  },
}))

const { streamResponse } = await import("./transport")

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "grok-4.5",
    thinking: "high",
    instructions: "Answer precisely",
    input: [{ type: "user_message", text: "inspect", images: [] }],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    cacheKey: "prompt-cache-key",
    toolChoice: "auto",
    sessionId: "session-456",
    ...overrides,
  }
}

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(requests[0]!.init.body))
}

async function run(overrides: Partial<StreamRequest> = {}): Promise<StreamEvent[]> {
  responses.push(sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]))
  return collect(streamResponse("profile-1", request(overrides)))
}

describe("xAI transport", () => {
  beforeEach(() => {
    requests.length = 0
    responses.length = 0
  })

  test("posts to /responses with the xAI-compatible request shape", async () => {
    await run()

    expect(requests[0]!.path).toBe("/responses")
    expect(requests[0]!.init.headers).toMatchObject({ "x-grok-conv-id": "session-456" })
    expect(sentBody()).toEqual({
      model: "grok-4.5",
      instructions: "Answer precisely",
      input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }],
      stream: true,
      store: false,
      prompt_cache_key: "prompt-cache-key",
      reasoning: { effort: "high" },
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      tool_choice: "auto",
    })
  })

  test("forwards auxiliary output limits without enabling tools", async () => {
    await run({ maxOutputTokens: 2000, toolChoice: "none" })
    expect(sentBody()).toMatchObject({ max_output_tokens: 2000, tool_choice: "none" })
  })

  test("omits reasoning.summary, include, and tool strict mode that xAI rejects", async () => {
    await run()

    const body = sentBody()
    expect(body).not.toHaveProperty("include")
    expect(body).not.toHaveProperty("parallel_tool_calls")
    expect(body.reasoning).not.toHaveProperty("summary")
    expect(body.tools).toEqual([expect.not.objectContaining({ strict: expect.anything() })])
  })

  test("leaves the effort dial to the model catalog", async () => {
    await run({ model: "grok-build-0.1", thinking: undefined })
    expect(sentBody()).not.toHaveProperty("reasoning")

    requests.length = 0
    await run({ model: "grok-4.6" })
    expect(sentBody()).toMatchObject({ reasoning: { effort: "high" } })
  })

  test("clamps efforts above the advertised range and omits a disabled dial", async () => {
    for (const [thinking, expected] of [
      ["max", { effort: "xhigh" }],
      ["xhigh", { effort: "xhigh" }],
      ["low", { effort: "low" }],
    ] as [ThinkingEffort, unknown][]) {
      requests.length = 0
      await run({ thinking })
      expect(sentBody().reasoning).toEqual(expected)
    }

    requests.length = 0
    await run({ thinking: "none" })
    expect(sentBody()).not.toHaveProperty("reasoning")
  })

  test("streams text, reasoning, tool calls, and usage", async () => {
    responses.push(
      sse([
        { type: "response.reasoning_text.delta", delta: "thinking" },
        { type: "response.output_text.delta", delta: "hello" },
        {
          type: "response.output_item.done",
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3 } } },
      ]),
    )

    const events = await collect(streamResponse("profile-1", request()))

    expect(events).toEqual([
      { type: "reasoning_summary_delta", text: "thinking" },
      { type: "text_delta", text: "hello" },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "hello",
          replay: {
            provider: "xai",
            model: "grok-4.5",
            data: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
          },
        },
      },
      {
        type: "item_done",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "read",
          args: { path: "a.ts" },
          replay: {
            provider: "xai",
            model: "grok-4.5",
            data: { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
          },
        },
      },
      { type: "done", usage: { totalInputTokens: 12, cacheReadInputTokens: undefined, outputTokens: 3 } },
    ])
  })

  test("fails loudly when the stream ends without a terminal event", async () => {
    responses.push(sse([{ type: "response.output_text.delta", delta: "partial" }]))
    await expect(collect(streamResponse("profile-1", request()))).rejects.toThrow("stream ended unexpectedly")
  })
})
