export type ToolSessionDisposer = (sessionId: string) => void

const disposers = new Set<ToolSessionDisposer>()
const contextDisposers = new Set<ToolSessionDisposer>()

export function registerToolSessionDisposer(disposer: ToolSessionDisposer): void {
  disposers.add(disposer)
}

export function registerToolContextDisposer(disposer: ToolSessionDisposer): void {
  contextDisposers.add(disposer)
}

export function disposeToolSession(sessionId: string): void {
  dispose(disposers, sessionId, `failed to dispose tool session ${sessionId}`)
}

export function disposeToolContext(sessionId: string): void {
  dispose(contextDisposers, sessionId, `failed to dispose tool context for session ${sessionId}`)
}

function dispose(registered: Set<ToolSessionDisposer>, sessionId: string, message: string): void {
  const failures: unknown[] = []
  for (const disposer of registered) {
    try {
      disposer(sessionId)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message)
}
