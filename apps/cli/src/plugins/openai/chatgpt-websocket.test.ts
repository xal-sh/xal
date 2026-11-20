import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test"
import { settings } from "../../config/settings"
import { streamWithWatchdog } from "../../providers/stream-watchdog"
import { isJsonObject, type JsonObject } from "../../lib/json"
import type { ConversationItem, StreamRequest } from "../../providers/types"

let mode: "answer" | "refuse" | "lost-context" | "unavailable" | "partial" | "stall" | "empty" | "unconfirmed" =
  "answer"
const socketRequests: JsonObject[] = []
const posts: JsonObject[] = []
let connections = 0
let received = Promise.withResolvers<void>()

function startServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (request.method === "POST") {
        const body: unknown = await request.json()
        if (!isJsonObject(body)) throw new Error("expected HTTP request object")
        posts.push(body)
        return new Response('data: {"type":"response.completed","response":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (mode !== "refuse" && server.upgrade(request)) return
      return new Response(null, { status: 426 })
    },
    websocket: {
      open() {
        connections++
      },
      message(socket, data) {
        const body: unknown = JSON.parse(data.toString())
        if (!isJsonObject(body)) throw new Error("expected response.create object")
        socketRequests.push(body)
        received.resolve()
        if (mode === "stall") return
        if (mode === "unavailable") {
          socket.send(
            JSON.stringify({
              type: "error",
              status: 503,
              error: { message: "upstream disconnected" },
              headers: { "Retry-After": "2" },
            }),
          )
          return
        }
        if (mode === "lost-context") {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "previous_response_not_found",
              error: { message: "response expired" },
            }),
          )
          return
        }
        if (mode === "partial") {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }))
          socket.close()
          return
        }
        const id = `response-${socketRequests.length}`
        if (mode === "empty" || mode === "unconfirmed") {
          socket.send(
            JSON.stringify({ type: "response.completed", response: mode === "empty" ? { id, output: [] } : { id } }),
          )
          return
        }
        const output = [
          { type: "reasoning", summary: [], encrypted_content: `encrypted-${id}` },
          { type: "function_call", name: "read", arguments: "{}", call_id: `call-${id}` },
        ]
        for (const item of output) socket.send(JSON.stringify({ type: "response.output_item.done", item }))
        socket.send(Buffer.from(JSON.stringify({ type: "response.completed", response: { id, output } })))
      },
    },
  })
}

let server: ReturnType<typeof startServer>
mock.module("./chatgpt-client", () => ({
  chatGptSocketTarget: (profileId: string) => ({
    url: `ws://127.0.0.1:${server.port}/responses`,
    headers: {},
    accountId: profileId,
  }),
  chatGptFetch: (_profileId: string, path: string, init: RequestInit) => fetch(new URL(path, server.url), init),
}))
const { streamResponse } = await import("./chatgpt-transport")
const { closeChatGptSocket } = await import("./chatgpt-websocket")
const { chatgptProvider } = await import("./provider")

beforeEach(() => {
  socketRequests.length = 0
  posts.length = 0
  connections = 0
  mode = "answer"
  received = Promise.withResolvers<void>()
  server = startServer()
})
afterEach(async () => {
  closeChatGptSocket("session")
  closeChatGptSocket("other")
  await server.stop(true)
})

function request(): StreamRequest {
  return {
    sessionId: "session",
    model: "test-model",
    instructions: "code",
    tools: [],
    toolChoice: "auto",
    cacheKey: "prompt",
    input: [{ type: "user_message", text: "start", images: [] }],
  }
}

async function followUp(sent: StreamRequest, profile = "profile"): Promise<StreamRequest> {
  const input: ConversationItem[] = [...sent.input]
  for await (const event of streamResponse(profile, sent)) {
    if (event.type === "item_done") input.push(event.item)
  }
  const call = input.at(-1)
  if (call?.type === "tool_call") input.push({ type: "tool_result", callId: call.callId, output: "result" })
  return { ...sent, input }
}

test("continues only an exact wire prefix on the same socket with unchanged options", async () => {
  const first = request()
  let next = await followUp(first)
  const user = { role: "user", content: [{ type: "input_text", text: "start" }] }
  expect(socketRequests[0]).toMatchObject({ type: "response.create", store: false, input: [user] })
  expect(socketRequests[0]).not.toHaveProperty("previous_response_id")
  next = await followUp(next)
  expect(socketRequests[1]).toMatchObject({
    previous_response_id: "response-1",
    input: [{ type: "function_call_output", call_id: "call-response-1", output: "result" }],
  })
  for (const change of [
    { tools: [{ name: "grep", description: "search", parameters: {} }] },
    { thinking: "high" } as const,
    { model: "other-model" },
    { input: first.input },
  ]) {
    next = await followUp({ ...next, ...change })
    expect(socketRequests.at(-1)).not.toHaveProperty("previous_response_id")
    expect(socketRequests.at(-1)?.input).toContainEqual(user)
  }
  expect(connections).toBe(1)
  next = await followUp(next, "other-profile")
  expect(socketRequests.at(-1)).not.toHaveProperty("previous_response_id")
  await followUp({ ...next, sessionId: "other" }, "other-profile")
  expect(socketRequests.at(-1)).not.toHaveProperty("previous_response_id")
  expect(connections).toBe(3)
  expect(posts).toHaveLength(0)
})

test("falls back to full HTTP history when an upgrade or a continuation is refused", async () => {
  const first = request()
  mode = "refuse"
  await followUp(first)
  expect(posts).toHaveLength(1)
  closeChatGptSocket(first.sessionId)
  mode = "answer"
  const next = await followUp(first)
  mode = "lost-context"
  await followUp(next)
  expect(socketRequests[1]?.previous_response_id).toBe("response-1")
  expect(posts).toHaveLength(2)
  expect(posts[1]).not.toHaveProperty("previous_response_id")
  expect(posts[1]?.input).toHaveLength(4)
  expect(posts[1]?.input).toContainEqual({ type: "reasoning", summary: [], encrypted_content: "encrypted-response-1" })
})

test("continues after confirmed empty output, but not after a terminal frame lacking output evidence", async () => {
  mode = "empty"
  let next = await followUp(request())
  mode = "unconfirmed"
  next = await followUp({ ...next, input: [...next.input, { type: "user_message", text: "continue", images: [] }] })
  expect(socketRequests[1]?.previous_response_id).toBe("response-1")
  expect(socketRequests[1]?.input).toHaveLength(1)
  await followUp(next)
  expect(socketRequests[2]).not.toHaveProperty("previous_response_id")
  expect(socketRequests[2]?.input).toHaveLength(2)
})

test("uses full HTTP on retry when an open socket times out before any output", async () => {
  mode = "stall"
  jest.useFakeTimers()
  try {
    const pending = streamWithWatchdog(chatgptProvider, "profile", request())
      .next()
      .catch((error: unknown) => error)
    await received.promise
    jest.advanceTimersByTime(settings().providerTimeouts.firstEventMs)
    expect(await pending).toMatchObject({ retryable: true })
    await followUp(request())
    expect(posts).toHaveLength(1)
    expect(posts[0]?.input).toEqual(socketRequests[0]?.input)
    expect(socketRequests).toHaveLength(1)
  } finally {
    jest.useRealTimers()
  }
})

test("preserves a transient socket error's retry delay and sends full history over HTTP on retry", async () => {
  const next = await followUp(request())
  mode = "unavailable"
  await expect(followUp(next)).rejects.toMatchObject({
    message: "upstream disconnected",
    retryable: true,
    retryAfterMs: 2_000,
  })
  expect(posts).toHaveLength(0)
  await followUp(next)
  expect(socketRequests).toHaveLength(2)
  expect(posts).toHaveLength(1)
  expect(posts[0]?.input).toHaveLength(4)
  expect(posts[0]).not.toHaveProperty("previous_response_id")
})

test("does not replay partial output or cancellation and starts clean on the next socket", async () => {
  const next = await followUp(request())
  mode = "partial"
  const stream = streamResponse("profile", next)
  expect((await stream.next()).value).toEqual({ type: "text_delta", text: "partial" })
  await expect(stream.next()).rejects.toMatchObject({ retryable: false })
  mode = "stall"
  received = Promise.withResolvers<void>()
  const controller = new AbortController()
  const pending = followUp({ ...next, signal: controller.signal })
  await received.promise
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  mode = "answer"
  await followUp(next)
  expect(socketRequests.at(-1)).not.toHaveProperty("previous_response_id")
  expect(connections).toBe(3)
  expect(posts).toHaveLength(0)
})
