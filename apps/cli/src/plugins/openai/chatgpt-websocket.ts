import { on } from "node:events"
import { isDeepStrictEqual } from "node:util"
import { describeError } from "../../lib/error"
import { asString, isRecord, type JsonObject } from "../../lib/json"
import { inputDelta } from "../../providers/conversation"
import { ProviderError } from "../../providers/errors"
import { parseSseEvent, type WireSseEvent } from "../../providers/responses"
import type { StreamRequest } from "../../providers/types"
import type { ChatGptSocketTarget } from "./chatgpt-client"

export class WebSocketUnavailable extends ProviderError {
  constructor(message: string) {
    super(message, { retryable: false })
  }
}

interface SocketSession {
  profileId: string
  accountId: string
  socket?: WebSocket
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
  continuation?: { id: string; key: string; prefix: JsonObject[] }
}

const sessions = new Map<string, SocketSession>()

export function closeChatGptSocket(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  clearTimeout(session.timer)
  session.socket?.close()
}

async function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.CONNECTING) {
    const timeout = AbortSignal.timeout(5_000)
    const opening = on(socket, "open", {
      close: ["error", "close"],
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    try {
      await opening.next()
    } catch (error) {
      signal?.throwIfAborted()
      throw new WebSocketUnavailable(`ChatGPT WebSocket handshake failed: ${describeError(error)}`)
    } finally {
      await opening.return?.()
    }
  }
  if (socket.readyState !== WebSocket.OPEN) throw new WebSocketUnavailable("ChatGPT WebSocket did not open")
}

async function* socketMessages(socket: WebSocket, payload: string, signal?: AbortSignal): AsyncGenerator<unknown> {
  const messages = on(socket, "message", { close: ["error", "close"], signal })
  try {
    try {
      socket.send(payload)
    } catch (error) {
      throw new WebSocketUnavailable(`ChatGPT WebSocket send failed: ${describeError(error)}`)
    }
    for await (const [message] of messages) {
      signal?.throwIfAborted()
      const data: unknown = message instanceof MessageEvent ? message.data : undefined
      const text = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : asString(data)
      if (text === undefined) throw new ProviderError("ChatGPT WebSocket expected a JSON frame", { retryable: false })
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new ProviderError("ChatGPT WebSocket received malformed JSON", { retryable: false })
      }
      yield raw
    }
  } finally {
    await messages.return?.()
  }
}

export async function* chatGptSocketFrames(
  target: ChatGptSocketTarget,
  profileId: string,
  request: StreamRequest,
  options: Record<string, unknown>,
  input: JsonObject[],
): AsyncGenerator<WireSseEvent> {
  const { sessionId, signal } = request
  signal?.throwIfAborted()
  let session = sessions.get(sessionId)
  if (session?.busy) throw new WebSocketUnavailable("ChatGPT WebSocket is busy")
  if (
    session &&
    (session.profileId !== profileId ||
      session.accountId !== target.accountId ||
      (session.socket && session.socket.readyState !== WebSocket.OPEN))
  ) {
    closeChatGptSocket(sessionId)
    session = undefined
  }
  if (session && !session.socket) throw new WebSocketUnavailable("ChatGPT WebSocket handshake is on cooldown")
  session ??= { profileId, accountId: target.accountId, busy: false }
  sessions.set(sessionId, session)
  clearTimeout(session.timer)
  session.busy = true
  let completed = false
  let started = false
  let cooldown = false
  try {
    if (!session.socket) {
      try {
        session.socket = new WebSocket(target.url, { headers: target.headers })
        session.socket.binaryType = "arraybuffer"
      } catch (error) {
        throw new WebSocketUnavailable(`ChatGPT WebSocket unavailable: ${describeError(error)}`)
      }
    }
    const socket = session.socket
    await waitForOpen(socket, signal)
    const key = JSON.stringify([
      request.model,
      request.conversationModel ?? request.model,
      request.maxOutputTokens,
      options,
    ])
    const previous = session.continuation
    const delta = previous?.key === key ? inputDelta(input, previous.prefix) : undefined
    session.continuation = undefined
    const payload = JSON.stringify({
      type: "response.create",
      ...options,
      input: delta ?? input,
      ...(delta && previous ? { previous_response_id: previous.id } : {}),
    })
    const prefix = delta && previous ? [...previous.prefix, ...structuredClone(delta)] : structuredClone(input)
    const output: JsonObject[] = []
    for await (const raw of socketMessages(socket, payload, signal)) {
      const frame = parseSseEvent(raw)
      if (!frame) continue
      if (
        !started &&
        frame.type === "failure" &&
        (frame.code === "websocket_connection_limit_reached" || (delta && frame.code === "previous_response_not_found"))
      )
        throw new WebSocketUnavailable(frame.message)
      if (started && frame.type === "failure") throw new ProviderError(frame.message, { retryable: false })
      if (frame.type === "item_done") output.push(structuredClone(frame.item))
      if (frame.type === "terminal") {
        const response = isRecord(raw) && isRecord(raw.response) ? raw.response : undefined
        const id = asString(response?.id)
        const confirmed =
          response?.output === undefined ? output.length > 0 : isDeepStrictEqual(response.output, output)
        if (id && confirmed && (!started || output.length > 0)) {
          session.continuation = { id, key, prefix: [...prefix, ...output] }
        }
        completed = true
      }
      started = true
      yield frame
      if (completed) return
    }
    signal?.throwIfAborted()
    if (started) throw new ProviderError("ChatGPT WebSocket closed during the response", { retryable: false })
    throw new WebSocketUnavailable("ChatGPT WebSocket closed before output")
  } catch (error) {
    if (signal?.aborted) {
      cooldown = !started && signal.reason instanceof ProviderError && signal.reason.retryable
      throw signal.reason
    }
    if (sessions.get(sessionId) !== session)
      throw new ProviderError("ChatGPT WebSocket session closed", { retryable: false })
    cooldown = error instanceof WebSocketUnavailable
    throw error
  } finally {
    session.busy = false
    if (!completed || signal?.aborted) {
      session.socket?.close()
      session.socket = undefined
      session.continuation = undefined
    }
    if (sessions.get(sessionId) === session) {
      if (!session.socket && !cooldown) sessions.delete(sessionId)
      else session.timer = setTimeout(() => closeChatGptSocket(sessionId), 60_000).unref()
    }
  }
}
