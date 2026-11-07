import { settings } from "../config/settings"
import { withAbortSignal } from "../lib/abort"
import { describeError } from "../lib/error"
import { redactText } from "../secrets/redactor"
import { ProviderError } from "./errors"
import type { Provider, StreamEvent, StreamRequest } from "./types"

export async function* streamWithWatchdog(
  provider: Provider,
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const { firstEventMs, idleMs } = settings().providerTimeouts
  const controller = new AbortController()
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const iterator = provider.stream(profileId, { ...request, signal })[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  let received = false
  let completed = false
  try {
    while (true) {
      const timeoutMs = received ? idleMs : firstEventMs
      timer = setTimeout(() => {
        controller.abort(
          new ProviderError(
            `${provider.name} stream timed out: ${received ? "no provider event" : "no first provider event"} for ${timeoutMs / 1_000}s; adjust providerTimeouts.${received ? "idleMs" : "firstEventMs"} for slow models`,
            { retryable: true },
          ),
        )
      }, timeoutMs)
      const result = await withAbortSignal(signal, () => iterator.next())
      clearTimeout(timer)
      signal.throwIfAborted()
      if (result.done) {
        completed = true
        return
      }
      received = true
      yield result.value
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (!completed && iterator.return) {
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch((error: unknown) => {
          console.error(redactText(`${provider.name} stream cleanup failed: ${describeError(error)}`))
        })
    }
  }
}
