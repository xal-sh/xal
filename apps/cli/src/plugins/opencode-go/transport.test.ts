import { describe, expect, mock, test } from "bun:test"
import { isJsonObject, type JsonObject } from "../../lib/json"
import type { StreamRequest, ToolDefinition } from "../../providers/types"

interface CapturedRequest {
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []
const tool: ToolDefinition = {
  name: "lookup",
  description: "Look up a value",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
}

mock.module("./api", () => ({
  PROVIDER_ID: "opencode-go",
  PROVIDER_NAME: "OpenCode Go",
  async goFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    if (path === "/responses") return new Response('data: {"type":"response.completed"}\n\n')
    if (path === "/messages") return new Response('data: {"type":"message_stop"}\n\n')
    return new Response("data: [DONE]\n\n")
  },
}))

mock.module("./auth", () => ({
  async apiKey(): Promise<string> {
    return "secret-key"
  },
}))

const { streamResponse } = await import("./transport")

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    instructions: "",
    tools: [],
    cacheKey: "key",
    model: "kimi-k3",
    input: [],
    toolChoice: "auto",
    sessionId: "session",
    ...overrides,
  }
}

async function routeFor(requestOverrides: Partial<StreamRequest>): Promise<string> {
  requests.length = 0
  for await (const _ of streamResponse("profile", request(requestOverrides))) void _
  return requests[0]?.path ?? "no request"
}

function body(): JsonObject {
  const parsed: unknown = JSON.parse(String(requests[0]!.init.body))
  if (!isJsonObject(parsed)) throw new Error("request body was not a JSON object")
  return parsed
}

describe("endpoint routing", () => {
  test("routes chat models to chat completions", async () => {
    expect(await routeFor({ model: "kimi-k3" })).toBe("/chat/completions")
  })

  test("routes responses models to responses", async () => {
    expect(await routeFor({ model: "grok-4.5" })).toBe("/responses")
  })

  test("routes anthropic models to messages", async () => {
    expect(await routeFor({ model: "qwen3.7-max" })).toBe("/messages")
  })

  test("unknown models fall back to chat completions", async () => {
    expect(await routeFor({ model: "brand-new-model" })).toBe("/chat/completions")
  })
})

describe("request options", () => {
  test("requests reasoning with encrypted content on responses", async () => {
    await routeFor({ model: "gpt-5.6-luna", thinking: "high" })
    expect(body()).toMatchObject({
      store: false,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    })
  })

  test("omits reasoning when no effort is selected", async () => {
    await routeFor({ model: "gpt-5.6-luna" })
    expect(body()["reasoning"]).toBeUndefined()
    expect(body()["store"]).toBe(false)
  })

  test("builds endpoint-specific tool payloads", async () => {
    await routeFor({ model: "kimi-k3", tools: [tool] })
    expect(body()).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        },
      ],
      tool_choice: "auto",
    })

    await routeFor({ model: "gpt-5.6-luna", tools: [tool] })
    expect(body()).toMatchObject({
      tools: [
        {
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    })

    await routeFor({ model: "qwen3.7-max", tools: [tool] })
    expect(body()).toMatchObject({
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
      tool_choice: { type: "auto" },
    })
  })

  test("keeps MiniMax M3 thinking adaptive unless disabled", async () => {
    await routeFor({ model: "minimax-m3", thinking: undefined })
    expect(body()).toMatchObject({ max_tokens: 128_000, thinking: { type: "adaptive" } })

    await routeFor({ model: "minimax-m3", thinking: "none" })
    expect(body()).toMatchObject({ thinking: { type: "disabled" } })
  })
})
