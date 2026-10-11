import { describeError } from "../../lib/error"
import { rememberRule } from "../../permissions/rules"
import type { ElicitationAnswer, ElicitationRequest, ElicitationResult } from "../../tools/types"
import type { AgentEvent, AgentState } from "../events"
import type { ApprovalResult } from "./tool-runner"

interface PendingElicitation {
  requestId: string
  callId: string
  request: ElicitationRequest
  resolve(result: ElicitationResult): void
}

interface InteractionHost {
  readonly interactive: boolean
  cwd(): string
  permissionSessionKey(): object
  emit(event: AgentEvent): void
  setState(state: AgentState): void
}

export class PendingInteractions {
  private approval: ((result: ApprovalResult) => void) | undefined
  private elicitation: PendingElicitation | undefined

  constructor(private readonly host: InteractionHost) {}

  awaitApproval(resolve: (result: ApprovalResult) => void, signal: AbortSignal): void {
    if (this.approval) throw new Error("another approval request is already pending")
    const abort = (): void => {
      this.resolveApproval({ decision: "deny", cause: "user" })
    }
    this.approval = (result) => {
      signal.removeEventListener("abort", abort)
      resolve(result)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }

  resolveApproval(result: ApprovalResult): void {
    const resolve = this.approval
    if (!resolve) return
    this.approval = undefined
    if (result.pattern && result.scope && result.scope !== "once") {
      rememberRule(this.host.permissionSessionKey(), this.host.cwd(), result.pattern, result.scope).catch((error) => {
        this.host.emit({ type: "error", message: describeError(error) })
      })
    }
    resolve(result)
  }

  answerElicitation(requestId: string, answers: ElicitationAnswer[]): boolean {
    const pending = this.elicitation
    if (!pending || pending.requestId !== requestId) return false

    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value.trim()]))
    if (byQuestion.size !== answers.length || byQuestion.size !== pending.request.questions.length) return false
    if ([...byQuestion.values()].some((value) => !value)) return false

    const normalized = pending.request.questions.flatMap((question): ElicitationAnswer[] => {
      const value = byQuestion.get(question.id)
      return value === undefined ? [] : [{ questionId: question.id, value }]
    })
    if (normalized.length !== pending.request.questions.length) return false

    this.resolveElicitation({ status: "answered", answers: normalized })
    return true
  }

  rejectElicitation(requestId: string): boolean {
    if (this.elicitation?.requestId !== requestId) return false
    this.resolveElicitation({ status: "rejected" })
    return true
  }

  resolveElicitation(result: ElicitationResult): void {
    const pending = this.elicitation
    if (!pending) return
    this.elicitation = undefined
    this.host.emit({ type: "elicitation_resolved", callId: pending.callId })
    pending.resolve(result)
  }

  async requestInput(callId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    if (!this.host.interactive) throw new Error("user input is unavailable without an interactive client")
    if (request.questions.length === 0) throw new Error("user input requires at least one question")
    if (this.elicitation) throw new Error("another user input request is already pending")
    if (signal.aborted) return { status: "rejected" }

    const requestId = crypto.randomUUID()
    const result = await new Promise<ElicitationResult>((resolve) => {
      this.elicitation = { requestId, callId, request, resolve }
      this.host.setState("awaiting_input")
      this.host.emit({ type: "elicitation_requested", requestId, callId, questions: request.questions })
    })
    if (!signal.aborted) this.host.setState("running_tool")
    return result
  }
}
