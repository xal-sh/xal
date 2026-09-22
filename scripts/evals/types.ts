export interface CaseVerdict {
  pass: boolean
  detail?: string
}

export type CaseCheck = (repo: string) => Promise<CaseVerdict> | CaseVerdict

export interface RunObservation {
  rounds: number
  toolCalls: number
  uncachedInputTokens: number
  outputTokens: number
  durationMs: number
  stopped?: "rounds" | "timeout"
  failure?: string
  error?: string
}

export interface RunRecord extends RunObservation {
  pass: boolean
  detail?: string
}

export interface CaseReport {
  name: string
  runs: RunRecord[]
  passRate: number
}

export interface EvalReport {
  mode: string
  runsPerCase: number
  cases: CaseReport[]
  passRate: number
  passRateSpread: number
  medianUncachedInputTokens: number
  totalUncachedInputTokens: number
}
