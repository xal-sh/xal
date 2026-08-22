import { describe, expect, mock, test } from "bun:test"
import type { JsonObject } from "../../lib/json"
import type { StreamRequest } from "../../providers/types"

interface CapturedRequest {
  path: string
  key: string
  init: RequestInit
}

const requests: CapturedRequest[] = []

mock.module("./api", () => ({
  PROVIDER_ID: "opencode-go",
  PROVIDER_NAME: "OpenCode Go",
  async goFetch(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    requests.push({ path, key, init })
    return new Response(undefined, { status: 500 })
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
  try {
    for await (const _ of streamResponse("profile", request(requestOverrides))) void _
  } catch {
    // a stubbed failed response is enough to observe which endpoint was hit
  }
  return requests[0]?.path ?? "no request"
}

function body(): JsonObject {
  const parsed: unknown = JSON.parse(requests[0]!.init.body as string)
  expect(typeof parsed).toBe("object")
  return parsed as JsonObject
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

  test("keeps MiniMax M3 thinking adaptive unless disabled", async () => {
    await routeFor({ model: "minimax-m3", thinking: undefined })
    expect(body()).toMatchObject({ max_tokens: 128_000, thinking: { type: "adaptive" } })

    await routeFor({ model: "minimax-m3", thinking: "none" })
    expect(body()).toMatchObject({ thinking: { type: "disabled" } })
  })
})
