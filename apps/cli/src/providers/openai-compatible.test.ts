import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Credential } from "../config/credentials"
import { events } from "../events"
import { isJsonObject, type JsonObject } from "../lib/json"
import lmstudio from "../plugins/lmstudio/plugin"
import ollama from "../plugins/ollama/plugin"
import compatible from "../plugins/openai-compatible/plugin"
import type { Plugin, PluginContext } from "../plugins/types"
import { redactText, REDACTION_MARKER } from "../secrets/redactor"
import { clearModelCatalog, modelCatalog } from "./catalog"
import { decisions } from "./decisions"
import type { ConnectContext, Provider, StreamEvent, StreamRequest } from "./types"

const credentials = new Map<string, Credential>()
const requests: { url: string; init: RequestInit }[] = []
const responses: Response[] = []

mock.module("../config/credentials", () => ({
  async loadCredential(providerId: string, profileId: string): Promise<Credential | undefined> {
    return credentials.get(`${providerId}/${profileId}`)
  },
}))

const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init: init ?? {} })
      init?.signal?.throwIfAborted()
      const response = responses.shift()
      if (!response) throw new Error("missing mocked local model response")
      return response
    },
    { preconnect() {} },
  ),
)

afterAll(() => fetchMock.mockRestore())
beforeEach(() => {
  credentials.clear()
  requests.length = 0
  responses.length = 0
  clearModelCatalog("local")
})

function provider(plugin: Plugin = ollama, config: Record<string, unknown> = {}): Provider {
  let registered: Provider | undefined
  const ctx: PluginContext = {
    config,
    events,
    runtime: {
      decisions,
      app: { name: "xal", version: "test" },
      paths: { home: "/tmp/xal", cache: "/tmp/xal/cache" },
      credentials: { load: async () => undefined, save: async () => {}, replace: async () => {} },
      protectSecret() {},
    },
    signal: new AbortController().signal,
    registerProvider(value) {
      if (value.kind !== "text") throw new Error("expected a text provider")
      registered = value
    },
    registerTool() {},
    unregisterTool() {},
    registerToolSessionDisposer() {},
    registerToolContextDisposer() {},
    registerCli() {},
    registerCommand() {},
    registerHook() {},
    registerPrompt() {},
    registerPolicyRule() {},
    registerPermissionRules() {},
    registerSecrets() {},
    registerUi() {},
    registerToolRenderer() {},
  }
  plugin.register(ctx)
  if (!registered) throw new Error("provider was not registered")
  return registered
}

function connectContext(method: number | undefined = 0, key?: string): ConnectContext {
  return { print() {}, select: async () => method, askSecret: async () => key }
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: "local-coder:latest",
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
  const raw: unknown = JSON.parse(String(requests.at(-1)!.init.body))
  if (!isJsonObject(raw)) throw new Error("request body was not an object")
  return raw
}

function sse(frames: unknown[] = []): Response {
  return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`)
}

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = []
  for await (const event of source) result.push(event)
  return result
}

for (const { plugin, id, name, port, aliases } of [
  { plugin: ollama, id: "ollama", name: "Ollama", port: 11434, aliases: [] },
  { plugin: lmstudio, id: "lmstudio", name: "LM Studio", port: 1234, aliases: ["lm-studio"] },
  { plugin: compatible, id: "openai-compatible", name: "OpenAI-compatible", port: 8080, aliases: [] },
]) {
  test(`${name} connects and discovers models on its default server without asking for a key`, async () => {
    const local = provider(plugin)
    expect(local.id).toBe(id)
    expect(local.name).toBe(name)
    expect(local.aliases).toEqual(aliases)
    const ctx = connectContext()
    ctx.askSecret = async () => {
      throw new Error("a key should not be requested")
    }
    responses.push(Response.json({ data: [{ id: "local-coder:latest" }] }))
    const auth = await local.connect?.(ctx)
    expect(auth).toEqual({ type: "none" })
    if (!auth) throw new Error("missing credential")
    credentials.set(`${id}/local`, auth)
    responses.push(Response.json({ data: [{ id: "local-coder:latest" }] }))
    expect(await local.listModels("local", true)).toEqual({
      source: "runtime",
      models: [{ kind: "text", id: "local-coder:latest", name: "local-coder:latest", inputModalities: ["text"] }],
    })
    responses.push(Response.json({ data: [{ id: "local-coder:latest" }] }))
    expect(await local.defaultModel("local")).toBe("local-coder:latest")
    expect(requests).toHaveLength(3)
    for (const sent of requests) {
      expect(sent.url).toBe(`http://localhost:${port}/v1/models`)
      expect(new Headers(sent.init.headers).get("authorization")).toBeNull()
      expect(sent.init.signal).toBeInstanceOf(AbortSignal)
      expect(sent.init.body).toBeUndefined()
      expect(sent.init.redirect).toBe("error")
    }
  })
}

describe("local model configuration and authentication", () => {
  test("normalizes custom endpoints and keeps each registered provider's settings independent", async () => {
    const custom = provider(compatible, {
      baseUrl: " http://127.0.0.1:8000/proxy/v1/// ",
      contextWindow: 32768,
      imageInput: true,
      clientName: "local-client",
    })
    const other = provider(compatible)
    credentials.set("openai-compatible/local", { type: "none" })
    responses.push(Response.json({ data: [{ id: "org/model" }] }))
    expect((await custom.listModels("local", false)).models[0]).toEqual({
      kind: "text",
      id: "org/model",
      name: "org/model",
      contextWindow: 32768,
      inputModalities: ["text", "image"],
    })
    expect(requests[0]!.url).toBe("http://127.0.0.1:8000/proxy/v1/models")
    expect(new Headers(requests[0]!.init.headers).get("user-agent")).toStartWith("local-client/")
    responses.push(Response.json({ data: [{ id: "other" }] }))
    expect((await other.listModels("local", false)).models[0]?.contextWindow).toBeUndefined()
    expect(requests[1]!.url).toBe("http://localhost:8080/v1/models")
  })

  test("rejects invalid endpoints, capabilities, and unknown settings before making requests", () => {
    for (const baseUrl of [
      "",
      "not a URL",
      "file:///tmp/models",
      "http://user:secret@localhost/v1",
      "http://localhost/v1?key=secret",
      "http://localhost/v1#fragment",
    ]) {
      expect(() => provider(ollama, { baseUrl })).toThrow("baseUrl")
    }
    for (const contextWindow of [0, -1, 1.5, "32768", null]) {
      expect(() => provider(ollama, { contextWindow })).toThrow("contextWindow must be a positive integer")
    }
    expect(() => provider(ollama, { imageInput: "true" })).toThrow("imageInput must be a boolean")
    expect(() => provider(ollama, { apiKey: "secret" })).toThrow("unknown option: apiKey")
    expect(() => provider(ollama, { baseUrl: "https://models.example.com/v1" })).not.toThrow()
    expect(requests).toHaveLength(0)
  })

  test("uses an optional API key only for the selected provider and profile", async () => {
    const local = provider(lmstudio)
    responses.push(Response.json({ data: [{ id: "local-coder:latest" }] }))
    const auth = await local.connect?.(connectContext(1, "  local-secret-token  "))
    expect(auth).toEqual({ type: "api_key", key: "local-secret-token" })
    expect(redactText("local-secret-token")).toBe(REDACTION_MARKER)
    if (!auth) throw new Error("missing credential")
    credentials.set("lmstudio/local", auth)
    responses.push(sse())
    await collect(local.stream("local", request()))
    for (const sent of requests) {
      expect(new Headers(sent.init.headers).get("authorization")).toBe("Bearer local-secret-token")
    }
    await expect(collect(local.stream("another-profile", request()))).rejects.toThrow("not connected")
    await expect(collect(provider(ollama).stream("local", request()))).rejects.toThrow("not connected")
    expect(requests).toHaveLength(2)
  })

  test("cancelled authentication, blank keys, and invalid selections do not contact the server", async () => {
    const local = provider()
    const cancelled = connectContext()
    cancelled.select = async () => undefined
    expect(await local.connect?.(cancelled)).toBeUndefined()
    expect(await local.connect?.(connectContext(1))).toBeUndefined()
    await expect(local.connect?.(connectContext(1, "  "))).rejects.toThrow("API key cannot be empty")
    await expect(local.connect?.(connectContext(2))).rejects.toThrow("invalid authentication method")
    expect(requests).toHaveLength(0)
  })

  test("invalid or empty catalogs cannot create a connection", async () => {
    const local = provider()
    for (const raw of [
      {},
      { data: [] },
      { data: [null] },
      { data: [{ id: " " }] },
      { data: [{ id: "same" }, { id: "same" }] },
    ]) {
      responses.push(Response.json(raw))
      await expect(local.connect?.(connectContext())).rejects.toThrow()
    }
  })

  test("discovery failures retain the existing process catalog with a visible warning", async () => {
    const local = provider()
    credentials.set("ollama/local", { type: "none" })
    responses.push(Response.json({ data: [{ id: "local-coder:latest" }] }))
    const catalog = await modelCatalog(local, "local")
    responses.push(new Response("server unavailable", { status: 503 }))
    const failed = await modelCatalog(local, "local", true)
    expect(failed.models).toEqual(catalog.models)
    expect(failed.warning).toContain("server unavailable")
    expect(failed.warning).toContain("using previous catalog")
  })
})

describe("local model streaming", () => {
  test("streams reasoning, text, fragmented tools and usage, then replays tool results", async () => {
    const local = provider()
    credentials.set("ollama/local", { type: "none" })
    responses.push(
      sse([
        { choices: [{ delta: { reasoning: "Check first" } }] },
        { choices: [{ delta: { content: "Looking up" } }] },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: '{"path":' } }] },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ]),
    )
    const signal = new AbortController().signal
    const result = await collect(
      local.stream(
        "local",
        request({
          signal,
          tools: [
            {
              name: "lookup",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        }),
      ),
    )
    expect(requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions")
    expect(requests[0]!.init.signal).toBe(signal)
    expect(requests[0]!.init.method).toBe("POST")
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBeNull()
    expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("text/event-stream")
    expect(body()).toMatchObject({
      model: "local-coder:latest",
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "lookup" } }],
    })
    expect(body().reasoning_effort).toBeUndefined()
    expect(body().prompt_cache_key).toBeUndefined()
    expect(result).toContainEqual({ type: "reasoning_summary_delta", text: "Check first" })
    expect(result).toContainEqual({ type: "text_delta", text: "Looking up" })
    const call = result.find((event) => event.type === "item_done" && event.item.type === "tool_call")
    expect(call).toMatchObject({
      type: "item_done",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "lookup",
        args: { path: "README.md" },
        replay: { provider: "ollama" },
      },
    })
    expect(result.at(-1)).toMatchObject({ type: "done", usage: { totalInputTokens: 12, outputTokens: 4 } })

    responses.push(sse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }]))
    await collect(
      local.stream(
        "local",
        request({
          input: [
            ...request().input,
            ...result.flatMap((event) => (event.type === "item_done" ? [event.item] : [])),
            { type: "tool_result", callId: "call-1", output: "found" },
          ],
          maxOutputTokens: 256,
        }),
      ),
    )
    expect(body().messages).toContainEqual({
      role: "assistant",
      content: "Looking up",
      reasoning_content: "Check first",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"path":"README.md"}' } }],
    })
    expect(body().messages).toContainEqual({ role: "tool", tool_call_id: "call-1", content: "found" })
    expect(body().max_tokens).toBe(256)
  })

  test("forwards images only when explicitly configured", async () => {
    credentials.set("lmstudio/local", { type: "none" })
    responses.push(sse())
    await collect(
      provider(lmstudio, { imageInput: true }).stream(
        "local",
        request({
          input: [{ type: "user_message", text: "inspect", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }],
        }),
      ),
    )
    expect(body().messages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ],
    })
    expect(provider(lmstudio).capabilities.imageInput).toBe(false)
  })

  test("reports HTTP failures and propagates cancellation", async () => {
    const local = provider()
    credentials.set("ollama/local", { type: "none" })
    responses.push(Response.json({ error: { message: "API key required" } }, { status: 401 }))
    await expect(collect(local.stream("local", request()))).rejects.toMatchObject({
      retryable: false,
      message: "Ollama request failed (401): API key required",
    })
    responses.push(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
    await expect(collect(local.stream("local", request()))).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
    })
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(collect(local.stream("local", request({ signal: controller.signal })))).rejects.toThrow("cancelled")
  })
})
