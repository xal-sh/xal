export type ToolSessionDisposer = (sessionId: string) => void

const disposers = new Set<ToolSessionDisposer>()

export function registerToolSessionDisposer(disposer: ToolSessionDisposer): void {
  disposers.add(disposer)
}

export function disposeToolSession(sessionId: string): void {
  const failures: unknown[] = []
  for (const disposer of disposers) {
    try {
      disposer(sessionId)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `failed to dispose tool session ${sessionId}`)
}
