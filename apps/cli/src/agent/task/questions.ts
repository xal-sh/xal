export const MAX_AGENT_MESSAGE_LENGTH = 20_000

export type ParentQuestionResult = { status: "answered"; answer: string } | { status: "unavailable"; reason: string }

export interface AgentQuestion {
  requestId: string
  jobId: string
  question: string
}

export interface DeliveredAgentQuestion extends AgentQuestion {
  unavailable(reason: string): void
}

export interface ParentQuestionChannel {
  ask(question: string, signal: AbortSignal): Promise<ParentQuestionResult>
  answer(message: string): string | undefined
  close(reason: string): void
  pending(): boolean
}

interface QuestionChannelOptions {
  jobId(): string
  deliver(question: DeliveredAgentQuestion): boolean
  settled(requestId: string): void
  waiting(question: string): void
  resumed(result: ParentQuestionResult): void
}

interface PendingQuestion {
  requestId: string
  resolve(result: ParentQuestionResult): void
  signal: AbortSignal
  abort(): void
}

export function createParentQuestionChannel(options: QuestionChannelOptions): ParentQuestionChannel {
  let pending: PendingQuestion | undefined

  const settle = (requestId: string, result: ParentQuestionResult): boolean => {
    if (!pending || pending.requestId !== requestId) return false
    const current = pending
    pending = undefined
    current.signal.removeEventListener("abort", current.abort)
    options.settled(requestId)
    options.resumed(result)
    current.resolve(result)
    return true
  }

  return {
    async ask(question, signal) {
      if (pending) throw new Error("a parent question is already pending")
      if (signal.aborted) return { status: "unavailable", reason: "the task was canceled" }

      const requestId = crypto.randomUUID()
      const { promise, resolve } = Promise.withResolvers<ParentQuestionResult>()
      const abort = (): void => {
        settle(requestId, { status: "unavailable", reason: "the task was canceled" })
      }
      pending = { requestId, resolve, signal, abort }
      signal.addEventListener("abort", abort, { once: true })
      options.waiting(question)

      let accepted: boolean
      try {
        accepted = options.deliver({
          requestId,
          jobId: options.jobId(),
          question,
          unavailable: (reason) => settle(requestId, { status: "unavailable", reason }),
        })
      } catch (error) {
        settle(requestId, { status: "unavailable", reason: "the parent could not receive the question" })
        throw error
      }
      if (!accepted) {
        settle(requestId, { status: "unavailable", reason: "the parent is unavailable" })
      }
      return promise
    },
    answer(message) {
      if (!pending) return undefined
      const requestId = pending.requestId
      return settle(requestId, { status: "answered", answer: message }) ? requestId : undefined
    },
    close(reason) {
      if (pending) settle(pending.requestId, { status: "unavailable", reason })
    },
    pending() {
      return pending !== undefined
    },
  }
}
