import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Credential } from "../../config/credentials"
import { isJsonObject, type JsonObject } from "../../lib/json"
import type { ConnectContext, StreamEvent, StreamRequest } from "../../providers/types"

const credentials = new Map<string, Credential>()
const requests: { url: string; init: RequestInit }[] = []
const responses: Response[] = []

mock.module("../../config/credentials", () => ({
  async loadCredential(providerId: string, profileId: string): Promise<Credential | undefined> {
    return credentials.get(`${providerId}/${profileId}`)
  },
}))

const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init: init ?? {} })
      const response = responses.shift()
      if (!response) throw new Error("missing mocked Kimi response")
      return response
    },
    { preconnect() {} },
  ),
)

afterAll(() => fetchMock.mockRestore())

const { kimiChinaProvider, kimiGlobalProvider } = await import("./provider")
const { connect } = await import("./auth")
const { BUNDLED_MODELS } = await import("./wire")

function context(key: string | undefined, print: ConnectContext["print"] = () => {}): ConnectContext {
  return { print, select: async () => undefined, askSecret: async () => key }
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "kimi-for-coding",
    instructions: "Answer precisely",
    input: [{ type: "user_message", text: "inspect", images: [] }],
    tools: [],
    cacheKey: "prompt-cache-key",
    toolChoice: "auto",
    sessionId: "session-1",
    ...overrides,
  }
}

function body(): JsonObject {
  const parsed: unknown = JSON.parse(String(requests.at(-1)!.init.body))
  if (!isJsonObject(parsed)) throw new Error("request body was not an object")
  return parsed
}

function sse(frames: unknown[] = []): Response {
  return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`)
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

beforeEach(() => {
  credentials.clear()
  requests.length = 0
  responses.length = 0
})

for (const { provider, host, id, alias } of [
  { provider: kimiGlobalProvider, host: "kimi.ai", id: "kimi-code-plan-global", alias: "kimi" },
  { provider: kimiChinaProvider, host: "kimi.com", id: "kimi-code-plan-cn", alias: "kimi-cn" },
]) {
  describe(`Kimi For Coding (${host})`, () => {
    test("exposes the regional provider and bundled coding models", async () => {
      expect(provider.id).toBe(id)
      expect(provider.name).toBe(`Kimi For Coding (${host})`)
      expect(provider.aliases).toEqual([alias])
      expect(provider.capabilities.imageInput).toBe(true)
      expect(await provider.defaultModel("profile")).toBe("kimi-for-coding")
      const catalog = await provider.listModels("profile", false)
      expect(catalog.source).toBe("bundled")
      expect(catalog.models.map((model) => model.id)).toEqual([
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
        "k3",
        "k3-256k",
        "k3.1-pro",
        "k3.1-pro-highspeed",
      ])
      expect(requests).toHaveLength(0)
    })

    test("validates a trimmed API key at the matching host without running inference", async () => {
      responses.push(Response.json({ data: [{ id: "kimi-for-coding" }] }))
      const printed: string[] = []
      expect(await provider.connect?.(context("  secret-key  ", (line) => printed.push(line)))).toEqual({
        type: "api_key",
        key: "secret-key",
      })
      expect(printed).toEqual([`connected to ${provider.name}`])
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe(`https://api.${host}/coding/v1/models`)
      expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer secret-key")
      expect(requests[0]!.init.body).toBeUndefined()
      expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal)
    })

    test("streams tools, reasoning, and images using only the selected region and profile", async () => {
      credentials.set(`${id}/profile`, { type: "api_key", key: `${host}-key` })
      responses.push(
        sse([
          { choices: [{ delta: { reasoning_content: "Check first" } }] },
          { choices: [{ delta: { content: "Looking up" } }] },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
          },
        ]),
      )
      const signal = new AbortController().signal
      const events = await collect(
        provider.stream(
          "profile",
          request({
            signal,
            input: [{ type: "user_message", text: "inspect", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }],
            tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: {} } }],
          }),
        ),
      )
      expect(requests[0]!.url).toBe(`https://api.${host}/coding/v1/chat/completions`)
      expect(requests[0]!.init.method).toBe("POST")
      expect(requests[0]!.init.signal).toBe(signal)
      expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe(`Bearer ${host}-key`)
      expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("text/event-stream")
      expect(body()).toMatchObject({
        model: "kimi-for-coding",
        stream: true,
        stream_options: { include_usage: true },
        prompt_cache_key: "prompt-cache-key",
        reasoning_effort: "max",
        tool_choice: "auto",
        tools: [{ type: "function", function: { name: "lookup" } }],
      })
      expect(body().messages).toContainEqual({
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        ],
      })
      expect(events).toContainEqual({ type: "reasoning_summary_delta", text: "Check first" })
      expect(events).toContainEqual({ type: "text_delta", text: "Looking up" })
      expect(events).toContainEqual({
        type: "item_done",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "lookup",
          args: {},
          replay: {
            provider: id,
            model: "kimi-for-coding",
            data: { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
          },
        },
      })
      expect(events.at(-1)).toEqual({
        type: "done",
        usage: { totalInputTokens: 12, outputTokens: 4, cacheReadInputTokens: 6 },
      })

      responses.push(sse())
      await collect(
        provider.stream(
          "profile",
          request({
            input: [
              ...request().input,
              ...events.flatMap((event) => (event.type === "item_done" ? [event.item] : [])),
              { type: "tool_result", callId: "call-1", output: "found" },
            ],
          }),
        ),
      )
      expect(body().messages).toContainEqual({
        role: "assistant",
        content: "Looking up",
        reasoning_content: "Check first",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      })
      expect(body().messages).toContainEqual({ role: "tool", tool_call_id: "call-1", content: "found" })
    })
  })
}

describe("Kimi authentication and discovery", () => {
  test("cancellation and blank keys never reach the network", async () => {
    expect(await connect("kimi-code-plan-global", context(undefined))).toBeUndefined()
    await expect(connect("kimi-code-plan-cn", context("  "))).rejects.toThrow("API key cannot be empty")
    expect(requests).toHaveLength(0)
  })

  test("rejected keys and invalid catalogs never report a successful connection", async () => {
    const printed: string[] = []
    responses.push(Response.json({ error: { message: "invalid key" } }, { status: 401 }))
    await expect(
      connect(
        "kimi-code-plan-global",
        context("bad", (line) => printed.push(line)),
      ),
    ).rejects.toMatchObject({ retryable: false })
    responses.push(Response.json({ data: [{ id: " " }] }))
    await expect(
      connect(
        "kimi-code-plan-cn",
        context("key", (line) => printed.push(line)),
      ),
    ).rejects.toThrow("model with no ID")
    expect(printed).toEqual([])
  })

  test("credentials cannot leak between regions or named profiles", async () => {
    credentials.set("kimi-code-plan-cn/profile", { type: "api_key", key: "cn-key" })
    await expect(collect(kimiGlobalProvider.stream("profile", request()))).rejects.toThrow(
      "not connected to Kimi For Coding (kimi.ai)",
    )
    await expect(collect(kimiChinaProvider.stream("another-profile", request()))).rejects.toThrow(
      "not connected to Kimi For Coding (kimi.com)",
    )
    expect(requests).toHaveLength(0)
  })

  test("refresh reads account-visible models and reported context and image capabilities", async () => {
    credentials.set("kimi-code-plan-cn/profile", { type: "api_key", key: "cn-key" })
    responses.push(
      Response.json({
        data: [
          { id: "k3-256k" },
          { id: "new-model", display_name: "New Model", context_length: 500_000, supports_image_in: true },
        ],
      }),
    )
    const catalog = await kimiChinaProvider.listModels("profile", true)
    expect(requests[0]!.url).toBe("https://api.kimi.com/coding/v1/models")
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer cn-key")
    expect(catalog.source).toBe("runtime")
    expect(catalog.models[0]).toMatchObject({ id: "k3-256k", contextWindow: 262_144, thinking: { default: "high" } })
    expect(catalog.models[1]).toEqual({
      kind: "text",
      id: "new-model",
      name: "New Model",
      contextWindow: 500_000,
      inputModalities: ["text", "image"],
    })
  })

  test("failed refreshes report the failure and retain bundled models", async () => {
    credentials.set("kimi-code-plan-global/profile", { type: "api_key", key: "key" })
    responses.push(Response.json({ data: [] }))
    const catalog = await kimiGlobalProvider.listModels("profile", true)
    expect(catalog.source).toBe("bundled")
    expect(catalog.models).toEqual(BUNDLED_MODELS)
    expect(catalog.warning).toContain("returned no models")
  })

  test("rate limits retain retry information", async () => {
    credentials.set("kimi-code-plan-global/profile", { type: "api_key", key: "key" })
    responses.push(new Response("quota exceeded", { status: 429, headers: { "retry-after": "2" } }))
    await expect(collect(kimiGlobalProvider.stream("profile", request()))).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 2_000,
    })
  })
})

describe("Kimi thinking controls", () => {
  test("the catalog and wire agree for every bundled model", async () => {
    credentials.set("kimi-code-plan-global/profile", { type: "api_key", key: "key" })
    for (const model of BUNDLED_MODELS) {
      for (const thinking of [undefined, ...(model.thinking?.options ?? [])]) {
        responses.push(sse())
        await collect(kimiGlobalProvider.stream("profile", request({ model: model.id, thinking })))
        expect(body().reasoning_effort).toBe(thinking ?? model.thinking?.default)
        expect(body().temperature).toBeUndefined()
      }
    }
  })

  test("unsupported efforts use the model default and unknown models omit the dial", async () => {
    credentials.set("kimi-code-plan-global/profile", { type: "api_key", key: "key" })
    responses.push(sse(), sse(), sse())
    await collect(kimiGlobalProvider.stream("profile", request({ model: "k3.1-pro", thinking: "none" })))
    expect(body().reasoning_effort).toBe("max")
    await collect(kimiGlobalProvider.stream("profile", request({ model: "k3", thinking: "medium" })))
    expect(body().reasoning_effort).toBe("high")
    await collect(kimiGlobalProvider.stream("profile", request({ model: "new-model", thinking: "max" })))
    expect(body().reasoning_effort).toBeUndefined()
  })
})
