import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { usageDir } from "../config/paths"
import type { Usage } from "../providers/types"

export type UsagePhase = "turn" | "compaction" | "goal_evaluation" | "permission_classification"
export type UsageOutcome = "completed" | "failed" | "interrupted"

export interface ProviderUsageInput {
  provider: string
  model: string
  phase: UsagePhase
  outcome: UsageOutcome
  usage: Usage
}

export interface ProviderUsageTokens {
  totalInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
}

export interface ProviderUsageRecord {
  type: "provider_usage"
  version: 1
  id: string
  timestamp: string
  provider: string
  model: string
  phase: UsagePhase
  outcome: UsageOutcome
  usage: ProviderUsageTokens
}

export class UsageRecorder {
  private readonly path: string
  private queue = Promise.resolve()
  private failure: unknown

  constructor(
    directory: string,
    runId: string = crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
    private readonly nextId: () => string = () => crypto.randomUUID(),
  ) {
    this.path = join(directory, `${runId}.jsonl`)
  }

  record(input: ProviderUsageInput): void {
    if (this.failure) return
    const cacheReadInputTokens = input.usage.cacheReadInputTokens ?? 0
    const cacheWriteInputTokens = input.usage.cacheWriteInputTokens ?? 0
    const record: ProviderUsageRecord = {
      type: "provider_usage",
      version: 1,
      id: this.nextId(),
      timestamp: this.now().toISOString(),
      provider: input.provider,
      model: input.model,
      phase: input.phase,
      outcome: input.outcome,
      usage: {
        totalInputTokens: input.usage.totalInputTokens ?? cacheReadInputTokens + cacheWriteInputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
        outputTokens: input.usage.outputTokens ?? 0,
      },
    }
    const writing = this.queue.then(() => {
      if (this.failure) throw new Error("usage recorder is unavailable", { cause: this.failure })
      return this.write(record)
    })
    this.queue = writing.catch((error: unknown) => {
      this.failure = error
    })
  }

  async flush(): Promise<void> {
    await this.queue
    if (this.failure) throw new Error("usage recorder is unavailable", { cause: this.failure })
  }

  private async write(record: ProviderUsageRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
  }
}

let recorder: UsageRecorder | undefined

export function startProviderUsageRecording(): void {
  recorder ??= new UsageRecorder(usageDir())
}

export function recordProviderUsage(input: ProviderUsageInput): void {
  recorder?.record(input)
}

export function flushProviderUsage(): Promise<void> {
  return recorder?.flush() ?? Promise.resolve()
}
