import { resolve } from "node:path"
import { settings } from "../config/settings"
import { describeError } from "../lib/error"
import { processExecutionDetail } from "../tools/execution"
import type { ProcessExecution, ToolExecutionContext } from "../tools/types"
import type { VerificationCheckStatus, VerificationEvidence, VerificationRecord } from "./types"
import { workspaceFingerprint } from "./workspace"

export function configuredCheck(command: string): { name: string; command: string } | undefined {
  const match = Object.entries(settings().verification.checks).find(([, configured]) => configured === command)
  return match ? { name: match[0], command: match[1] } : undefined
}

async function workspaceEvidence(cwd: string, signal?: AbortSignal): Promise<VerificationEvidence> {
  try {
    return { status: "captured", fingerprint: await workspaceFingerprint(cwd, signal) }
  } catch (error) {
    return { status: "unavailable", reason: `workspace evidence unavailable: ${describeError(error)}` }
  }
}

async function recordVerification(record: VerificationRecord, ctx: ToolExecutionContext): Promise<void> {
  if (!ctx.recordVerification) throw new Error("verification recording is unavailable; check was not recorded")
  await ctx.recordVerification(record)
}

export async function startVerification(
  check: { name: string; command: string },
  ctx: ToolExecutionContext,
): Promise<{ record: Extract<VerificationRecord, { status: "started" }>; evidence: VerificationEvidence }> {
  const record: Extract<VerificationRecord, { status: "started" }> = {
    ...check,
    id: crypto.randomUUID(),
    cwd: resolve(ctx.cwd),
    startedAt: Date.now(),
    status: "started",
  }
  await recordVerification(record, ctx)
  return { record, evidence: await workspaceEvidence(ctx.cwd, ctx.signal) }
}

export async function finishVerification(
  started: Awaited<ReturnType<typeof startVerification>>,
  execution: ProcessExecution,
  ctx: ToolExecutionContext,
): Promise<void> {
  const after = await workspaceEvidence(started.record.cwd, ctx.signal)
  const evidence: VerificationEvidence =
    started.evidence.status === "unavailable"
      ? started.evidence
      : after.status === "unavailable"
        ? after
        : after.fingerprint === started.evidence.fingerprint
          ? after
          : { status: "unavailable", reason: "workspace changed while the check ran" }
  await recordVerification(
    {
      ...started.record,
      status: "finished",
      finishedAt: Math.max(Date.now(), started.record.startedAt),
      execution,
      evidence,
    },
    ctx,
  )
}

export async function verificationSummary(
  cwd: string,
  records: ReadonlyMap<string, VerificationRecord>,
  unsettled: boolean,
  signal?: AbortSignal,
): Promise<VerificationCheckStatus[] | undefined> {
  const checks = Object.entries(settings().verification.checks)
  if (checks.length === 0) return undefined
  const matching = checks.map(([name, command]) => {
    const record = records.get(name)
    return record?.command === command && record.cwd === resolve(cwd) ? record : undefined
  })
  let fingerprint: string | undefined
  let unavailable = unsettled ? "background work is unsettled" : undefined
  if (
    !unavailable &&
    matching.some((record) => record?.status === "finished" && record.evidence.status === "captured")
  ) {
    const evidence = await workspaceEvidence(cwd, signal)
    if (evidence.status === "captured") fingerprint = evidence.fingerprint
    else unavailable = evidence.reason
  }
  return checks.map(([name, command], index): VerificationCheckStatus => {
    const record = matching[index]
    if (!record) return { name, command, status: "not_run", detail: "no run recorded for this command and workspace" }
    if (record.status === "started") {
      return { name, command, status: "failed", detail: "check started but no completion was recorded" }
    }
    const detail = processExecutionDetail(record.execution)
    const stale =
      unavailable ??
      (record.evidence.status === "unavailable"
        ? record.evidence.reason
        : record.evidence.fingerprint !== fingerprint
          ? "workspace changed since this check"
          : undefined)
    if (stale) return { name, command, status: "stale", detail: `${detail}; ${stale}` }
    const passed = record.execution.status === "exited" && record.execution.exitCode === 0
    return { name, command, status: passed ? "passed" : "failed", detail }
  })
}

export type VerificationGate = { type: "required" } | { type: "changed"; fingerprint: string }

export async function verificationGate(cwd: string, signal?: AbortSignal): Promise<VerificationGate | undefined> {
  const verification = settings().verification
  switch (verification.gate) {
    case false:
      return undefined
    case "required":
      return { type: "required" }
    case true: {
      if (Object.keys(verification.checks).length === 0) return undefined
      const evidence = await workspaceEvidence(cwd, signal)
      return evidence.status === "captured" ? { type: "changed", fingerprint: evidence.fingerprint } : undefined
    }
  }
}

export async function verificationCorrection(
  cwd: string,
  gate: VerificationGate,
  records: ReadonlyMap<string, VerificationRecord>,
  unsettled: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (gate.type === "changed") {
    const evidence = await workspaceEvidence(cwd, signal)
    if (evidence.status === "captured" && evidence.fingerprint === gate.fingerprint) return undefined
  }
  const checks = await verificationSummary(cwd, records, unsettled, signal)
  if (gate.type === "required") {
    const failure = requiredVerificationFailure(checks)
    if (!failure) return undefined
    return `${failure}\nRun every configured check against the current workspace and fix failures caused by your change before finishing. Continue to follow the user's instructions and permission rules; a blocked or unavailable check cannot be waived by explaining it.`
  }
  if (!checks || checks.every((check) => check.status === "passed")) return undefined
  return [
    "You changed the workspace during this turn, but not every configured check has passed against the current workspace:",
    ...verificationDetails(checks),
    "Run the checks that cover your change and fix failures it caused before finishing, or say which check cannot pass and why.",
  ].join("\n")
}

export function requiredVerificationFailure(checks: VerificationCheckStatus[] | undefined): string | undefined {
  if (!checks?.length) return "Required verification has no configured checks."
  if (checks.every((check) => check.status === "passed")) return undefined
  return ["Not every required check has passed against the current workspace:", ...verificationDetails(checks)].join(
    "\n",
  )
}

export function verificationHeadline(checks: VerificationCheckStatus[]): string {
  return `Checks: ${checks.map((check) => `${check.name} ${check.status.replace("_", " ")}`).join(" · ")}`
}

export function verificationDetails(checks: VerificationCheckStatus[]): string[] {
  return checks.map((check) => `${check.name}: ${check.status.replace("_", " ")} · ${check.detail}\n${check.command}`)
}
