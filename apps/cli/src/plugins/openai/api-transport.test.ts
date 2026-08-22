import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamRequest } from "../../providers/types"

interface CapturedRequest {
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []

mock.module("./api-auth", () => ({
  async apiKey(): Promise<string> {
    return "sk-test"
  },
}))

mock.module("./api-client", () => ({
  PROVIDER_ID: "openai",
  PROVIDER_NAME: "OpenAI",
  async openAiFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked OpenAI response")
    return response
  },
  async raiseForStatus(response: Response): Promise<never> {
    throw new Error(`OpenAI request failed (${response.status})`)
  },
}))

const { streamResponse } = await import("./api-transport")

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "gpt-5.2",
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
    sessionId: "session-123",
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

beforeEach(() => {
  requests.length = 0
  responses.length = 0
})

describe("OpenAI Responses transport", () => {
  test("sends the OpenAI Responses request shape and streams replayable output", async () => {
    const output = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    }
    responses.push(
      sse([
        { type: "response.output_text.delta", delta: "done" },
        { type: "response.output_item.done", item: output },
        { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 2 } } },
      ]),
    )

    const events = await collect(streamResponse("profile-1", request()))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe("/responses")
    expect(requests[0]!.key).toBe("sk-test")
    expect(requests[0]!.init.method).toBe("POST")
    expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("text/event-stream")
    expect(new Headers(requests[0]!.init.headers).get("x-client-request-id")).toBeTruthy()
    expect(sentBody()).toEqual({
      model: "gpt-5.2",
      store: false,
      stream: true,
      instructions: "Answer precisely",
      input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }],
      prompt_cache_key: "prompt-cache-key",
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
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
    })
    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "done",
          replay: { provider: "openai", model: "gpt-5.2", data: output },
        },
      },
      {
        type: "done",
        usage: {
          totalInputTokens: 8,
          cacheReadInputTokens: undefined,
          cacheWriteInputTokens: undefined,
          outputTokens: 2,
        },
      },
    ])
  })

  test("omits reasoning and tool fields for a non-reasoning request with no tools", async () => {
    responses.push(sse([{ type: "response.completed", response: {} }]))

    await collect(streamResponse("profile-1", request({ model: "gpt-4.1", thinking: undefined, tools: [] })))

    expect(sentBody()).not.toHaveProperty("reasoning")
    expect(sentBody()).not.toHaveProperty("include")
    expect(sentBody()).not.toHaveProperty("tools")
    expect(sentBody()).not.toHaveProperty("tool_choice")
  })

  test("sends the synthetic 1M Sol model as its underlying wire model", async () => {
    responses.push(sse([{ type: "response.completed", response: {} }]))

    await collect(streamResponse("profile-1", request({ model: "gpt-5.6-sol-1m" })))

    expect(sentBody().model).toBe("gpt-5.6-sol")
  })

  test("preserves every OpenAI reasoning effort accepted by the catalog", async () => {
    for (const effort of ["none", "xhigh", "max"] as const) {
      requests.length = 0
      responses.push(sse([{ type: "response.completed", response: {} }]))

      await collect(streamResponse("profile-1", request({ thinking: effort })))

      expect(sentBody().reasoning).toMatchObject({ effort })
    }
  })

  test("rejects incomplete responses instead of accepting truncated output", async () => {
    responses.push(
      sse([
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
    )

    await expect(collect(streamResponse("profile-1", request()))).rejects.toMatchObject({
      message: "response incomplete: max_output_tokens",
      retryable: false,
    })
  })

  test("surfaces OpenAI HTTP errors before reading the stream", async () => {
    responses.push(Response.json({ error: { message: "invalid request" } }, { status: 400 }))

    await expect(collect(streamResponse("profile-1", request()))).rejects.toThrow("OpenAI request failed (400)")
  })
})
