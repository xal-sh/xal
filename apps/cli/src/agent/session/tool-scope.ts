import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { withAbortSignal } from "../../lib/abort"
import { describeError } from "../../lib/error"
import { writeNewSecureText, writeSecureJson } from "../../lib/fs"
import { redactJsonObject, redactText } from "../../secrets/redactor"
import { toolFailed } from "../../tools/output"
import type { ToolInvoker } from "../../tools/programmatic"
import type { ToolCallItem } from "../../providers/types"
import type { ToolResult } from "../../tools/types"
import type { PreparedToolCall, ToolCallOutcome, ToolCallPreparation } from "./tool-runner"

export class ToolCallScope {
  readonly directory: string
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<string>>()
  private readonly waiting: Array<() => void> = []
  private preparing = Promise.resolve()
  private running = 0
  private count = 0
  private bytes = 0
  private failure: Error | undefined

  constructor(
    private readonly parent: ToolCallItem,
    directory: string,
    signal: AbortSignal,
    private readonly prepare: (
      call: ToolCallItem,
      signal: AbortSignal,
      updateCall: (call: ToolCallItem) => Promise<void>,
    ) => Promise<ToolCallPreparation>,
    private readonly execute: (prepared: PreparedToolCall, signal: AbortSignal) => Promise<ToolCallOutcome>,
    private readonly update: (text: string) => void,
  ) {
    this.directory = join(directory, `calls-${crypto.randomUUID()}`)
    this.signal = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(60_000)])
  }

  readonly callTool: ToolInvoker = (name, args, signal) => {
    const call: ToolCallItem = {
      type: "tool_call",
      callId: crypto.randomUUID(),
      name,
      args: redactJsonObject(args),
    }
    const index = ++this.count
    const task = this.dispatch(call, index, AbortSignal.any([this.signal, signal])).finally(() => {
      this.pending.delete(task)
    })
    this.pending.add(task)
    void task.then(undefined, (error: unknown) => {
      this.failure ??= new Error(redactText(describeError(error)))
      this.controller.abort(this.failure)
    })
    return task
  }

  async run(execute: (signal: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      this.signal.throwIfAborted()
      const result = await withAbortSignal(this.signal, () => execute(this.signal))
      await withAbortSignal(this.signal, () => Promise.all(this.pending))
      if (this.failure) throw this.failure
      this.signal.throwIfAborted()
      return result
    } finally {
      this.controller.abort()
      await Promise.allSettled(this.pending)
    }
  }

  private async dispatch(call: ToolCallItem, index: number, signal: AbortSignal): Promise<string> {
    if (index > 32) throw new Error("Code Mode allows at most 32 child tool calls")
    if (this.running < 4) this.running += 1
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      signal.throwIfAborted()
      const path = join(this.directory, `${String(index).padStart(2, "0")}.json`)
      await writeNewSecureText(
        path,
        JSON.stringify({ version: 1, parentCallId: this.parent.callId, status: "started", call }) + "\n",
      )
      let recording = Promise.resolve()
      let outcome: ToolCallOutcome
      try {
        const previous = this.preparing
        const next = Promise.withResolvers<void>()
        this.preparing = next.promise
        let preparation: ToolCallPreparation
        try {
          await previous
          signal.throwIfAborted()
          preparation = await withAbortSignal(signal, () =>
            this.prepare(call, signal, (effective) => {
              signal.throwIfAborted()
              call = effective
              recording = writeSecureJson(path, {
                version: 1,
                parentCallId: this.parent.callId,
                status: "started",
                call,
              })
              return recording
            }),
          )
        } finally {
          next.resolve()
        }
        outcome =
          preparation.type === "outcome"
            ? preparation.outcome
            : await withAbortSignal(signal, () => this.execute(preparation.prepared, signal))
      } catch (error) {
        await recording
        await writeSecureJson(path, {
          version: 1,
          parentCallId: this.parent.callId,
          status: "failed",
          call,
          error: redactText(describeError(error)),
        })
        throw error
      }
      await writeSecureJson(path, { version: 1, parentCallId: this.parent.callId, status: "completed", ...outcome })
      if (!signal.aborted)
        this.update(
          `${call.name}: ${outcome.failure || outcome.denial || toolFailed(outcome.output) ? "failed" : "finished"}\n`,
        )
      if (outcome.failure || outcome.denial || toolFailed(outcome.output))
        throw new Error(`${call.name}: ${(outcome.failure ?? outcome.output).slice(0, 2_000)}`)
      signal.throwIfAborted()
      this.bytes += Buffer.byteLength(outcome.output)
      if (Buffer.byteLength(outcome.output) > 5 * 1024 * 1024 || this.bytes > 16 * 1024 * 1024) {
        throw new Error("Code Mode tool results exceeded 5 MiB per call or 16 MiB in total; narrow the requests")
      }
      return outcome.output
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.running -= 1
    }
  }
}
