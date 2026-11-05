import { asNumber, asString, isRecord } from "../lib/json"
import { parseProcessExecution } from "../tools/execution"
import type { ProcessExecution } from "../tools/types"

export type VerificationEvidence =
  { status: "captured"; fingerprint: string } | { status: "unavailable"; reason: string }

interface VerificationIdentity {
  id: string
  name: string
  command: string
  cwd: string
  startedAt: number
}

export type VerificationRecord = VerificationIdentity &
  (
    | { status: "started" }
    | { status: "finished"; finishedAt: number; execution: ProcessExecution; evidence: VerificationEvidence }
  )

export interface VerificationRecordedEvent {
  type: "verification_recorded"
  record: VerificationRecord
}

export interface VerificationCheckStatus {
  name: string
  command: string
  status: "passed" | "failed" | "not_run" | "stale"
  detail: string
}

export function parseVerificationRecord(value: unknown): VerificationRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const name = asString(value.name)
  const command = asString(value.command)
  const cwd = asString(value.cwd)
  const startedAt = asNumber(value.startedAt)
  if (
    !id ||
    !name ||
    !command ||
    !cwd ||
    startedAt === undefined ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  ) {
    return undefined
  }
  const identity = { id, name, command, cwd, startedAt }
  if (value.status === "started") return { ...identity, status: "started" }
  if (value.status !== "finished") return undefined
  const finishedAt = asNumber(value.finishedAt)
  const execution = parseProcessExecution(value.execution)
  if (
    finishedAt === undefined ||
    !Number.isSafeInteger(finishedAt) ||
    finishedAt < startedAt ||
    !execution ||
    !isRecord(value.evidence)
  ) {
    return undefined
  }
  const result = { ...identity, finishedAt, execution }
  if (value.evidence.status === "captured") {
    const fingerprint = asString(value.evidence.fingerprint)
    if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return undefined
    return { ...result, status: "finished", evidence: { status: "captured", fingerprint } }
  }
  if (value.evidence.status === "unavailable") {
    const reason = asString(value.evidence.reason)
    if (!reason) return undefined
    return { ...result, status: "finished", evidence: { status: "unavailable", reason } }
  }
  return undefined
}

export function parseVerificationSummary(value: unknown): VerificationCheckStatus[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: VerificationCheckStatus[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const name = asString(entry.name)
    const command = asString(entry.command)
    const detail = asString(entry.detail)
    const status = entry.status
    if (!name || !command || detail === undefined) return undefined
    if (status !== "passed" && status !== "failed" && status !== "not_run" && status !== "stale") return undefined
    result.push({ name, command, status, detail })
  }
  return result
}
