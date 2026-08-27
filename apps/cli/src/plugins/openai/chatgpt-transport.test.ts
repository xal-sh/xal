import { beforeEach, describe, expect, mock, test } from "bun:test"
import { ProviderError } from "../../providers/errors"
import type { StreamEvent, StreamRequest } from "../../providers/types"

interface CapturedRequest {
  profileId: string
  path: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []

mock.module("./chatgpt-client", () => ({
  async chatGptFetch(profileId: string, path: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ profileId, path, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked ChatGPT response")
    return response
  },
}))

mock.module("./chatgpt-oauth", () => ({ PROVIDER_ID: "openai-chatgpt", PROVIDER_NAME: "ChatGPT" }))

const { streamResponse } = await import("./chatgpt-transport")

function request(input: StreamRequest["input"] = []): StreamRequest {
  return {
    model: "gpt-5.6-sol-fast",
    thinking: "high",
    instructions: "Answer precisely",
    input,
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    cacheKey: "prompt-cache-key",
    toolChoice: "auto",
    sessionId: "session-123",
  }
}

function sse(frames: unknown[], done = false, trailing = ""): Response {
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}${trailing}`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
})

describe("ChatGPT transport", () => {
  test("sends replayable input and maps a terminal response stream", async () => {
    const replay = {
      type: "message",
      id: "provider-item",
      role: "assistant",
      content: [{ type: "output_text", text: "earlier answer" }],
    }
    const output = {
      type: "message",
      id: "response-item",
      role: "assistant",
      content: [{ type: "output_text", text: "final answer" }],
    }
    responses.push(
      sse(
        [
          { type: "response.output_text.delta", delta: "final" },
          { type: "response.reasoning_summary_text.delta", delta: "checked" },
          { type: "response.reasoning_text.delta", delta: "private" },
          { type: "response.output_item.done", item: output },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 20,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
              },
            },
          },
        ],
        false,
        "data: {malformed}\n\n",
      ),
    )

    const events = await collect(
      streamResponse(
        "test-profile",
        request([
          { type: "user_message", text: "continue", images: [] },
          {
            type: "assistant_message",
            text: "portable fallback",
            replay: { provider: "openai-chatgpt", model: "gpt-5.6-sol-fast", data: replay },
          },
        ]),
      ),
    )

    expect(events).toEqual([
      { type: "text_delta", text: "final" },
      { type: "reasoning_summary_delta", text: "checked" },
      { type: "reasoning_delta", text: "private" },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "final answer",
          replay: {
            provider: "openai-chatgpt",
            model: "gpt-5.6-sol-fast",
            data: output,
          },
        },
      },
      {
        type: "done",
        usage: {
          totalInputTokens: 20,
          cacheReadInputTokens: 7,
          cacheWriteInputTokens: 3,
          outputTokens: 4,
        },
      },
    ])

    expect(requests).toHaveLength(1)
    const captured = requests[0]
    if (!captured) throw new Error("ChatGPT request was not captured")
    expect(captured.profileId).toBe("test-profile")
    expect(captured.path).toBe("/responses")
    expect(captured.init.method).toBe("POST")
    expect(new Headers(captured.init.headers).get("session-id")).toBe("session-123")
    expect(new Headers(captured.init.headers).get("accept")).toBe("text/event-stream")
    if (typeof captured.init.body !== "string") throw new Error("ChatGPT request body was not a string")
    expect(JSON.parse(captured.init.body)).toEqual({
      model: "gpt-5.6-sol",
      service_tier: "priority",
      store: false,
      stream: true,
      instructions: "Answer precisely",
      input: [{ role: "user", content: [{ type: "input_text", text: "continue" }] }, replay],
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "prompt-cache-key",
    })
  })

  test("sends a legacy 1M Sol model ID as its underlying wire model", async () => {
    responses.push(sse([{ type: "response.completed", response: {} }]))

    await collect(streamResponse("test-profile", { ...request(), model: "gpt-5.6-sol-1m" }))

    const body = requests[0]?.init.body
    if (typeof body !== "string") throw new Error("ChatGPT request body was not a string")
    const sent = JSON.parse(body)
    expect(sent).toMatchObject({ model: "gpt-5.6-sol" })
    expect(sent).not.toHaveProperty("service_tier")
  })

  test("sends a legacy fast 1M Sol model ID with priority service", async () => {
    responses.push(sse([{ type: "response.completed", response: {} }]))

    await collect(streamResponse("test-profile", { ...request(), model: "gpt-5.6-sol-1m-fast" }))

    const body = requests[0]?.init.body
    if (typeof body !== "string") throw new Error("ChatGPT request body was not a string")
    expect(JSON.parse(body)).toMatchObject({ model: "gpt-5.6-sol", service_tier: "priority" })
  })

  test("surfaces streamed failures with their retry classification", async () => {
    responses.push(
      sse([
        {
          type: "response.failed",
          response: { error: { code: "server_error", message: "temporarily overloaded" } },
        },
      ]),
    )

    let thrown: unknown
    try {
      await collect(streamResponse("test-profile", request()))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ProviderError)
    if (!(thrown instanceof ProviderError)) throw new Error("expected ProviderError")
    expect(thrown.message).toBe("temporarily overloaded")
    expect(thrown.retryable).toBe(true)
  })

  test("rejects a stream that ends before a terminal event", async () => {
    responses.push(sse([{ type: "response.output_text.delta", delta: "partial" }]))

    await expect(collect(streamResponse("test-profile", request()))).rejects.toMatchObject({
      message: "ChatGPT stream ended unexpectedly",
      retryable: true,
    })
  })
})
