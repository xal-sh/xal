export async function withAbortSignal<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const abort = (): void => stopped.reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return execute()
      }),
      stopped.promise,
    ])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
