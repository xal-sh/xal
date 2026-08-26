import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamRequest } from "../../providers/types"

interface CapturedRequest {
  path: string
  accessToken: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const responses: Response[] = []

mock.module("./credential", () => ({
  async token(): Promise<string> {
    return "github-token"
  },
}))

mock.module("./models", () => ({
  async modelEndpoint(_profileId: string, model: string): Promise<string> {
    return model.startsWith("claude-") ? "/chat/completions" : "/responses"
  },
}))

mock.module("./api", () => ({
  PROVIDER_ID: "github-copilot",
  async copilotFetch(path: string, accessToken: string, init: RequestInit): Promise<Response> {
    requests.push({ path, accessToken, init })
    const response = responses.shift()
    if (!response) throw new Error("missing mocked Copilot response")
    return response
  },
}))

const { streamResponse } = await import("./transport")

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "gpt-5.6-luna",
    thinking: "max",
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

beforeEach(() => {
  requests.length = 0
  responses.length = 0
})

describe("GitHub Copilot transport", () => {
  test("uses the Responses protocol for newer Copilot models", async () => {
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

    const events = await collect(
      streamResponse(
        "profile-1",
        request({
          input: [
            {
              type: "user_message",
              text: "inspect",
              images: [{ mediaType: "image/png", data: "YWJjZA==" }],
            },
          ],
        }),
      ),
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe("/responses")
    expect(requests[0]!.accessToken).toBe("github-token")
    expect(requests[0]!.init.method).toBe("POST")
    expect(Object.fromEntries(new Headers(requests[0]!.init.headers))).toMatchObject({
      accept: "text/event-stream",
      "openai-intent": "conversation-edits",
      "x-initiator": "user",
    })
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
      instructions: "Answer precisely",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", image_url: "data:image/png;base64,YWJjZA==" },
          ],
        },
      ],
      reasoning: { effort: "max", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
          replay: { provider: "github-copilot", model: "gpt-5.6-luna", data: output },
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

  test("keeps Chat Completions routing for Claude models", async () => {
    responses.push(
      new Response(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    )

    const events = await collect(
      streamResponse(
        "profile-1",
        request({
          model: "claude-sonnet-4.6",
          thinking: "high",
          input: [
            {
              type: "user_message",
              text: "inspect",
              images: [{ mediaType: "image/jpeg", data: "YWJjZA==" }],
            },
          ],
        }),
      ),
    )

    expect(requests[0]!.path).toBe("/chat/completions")
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: "claude-sonnet-4.6",
      reasoning_effort: "high",
      stream: true,
      messages: [
        { role: "system", content: "Answer precisely" },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJjZA==" } },
          ],
        },
      ],
    })
    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: "done",
          replay: {
            provider: "github-copilot",
            model: "claude-sonnet-4.6",
            data: { content: "done" },
          },
        },
      },
      { type: "done", usage: { totalInputTokens: 4, cacheReadInputTokens: undefined, outputTokens: 1 } },
    ])
  })
})
