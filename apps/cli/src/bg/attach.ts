import { open, rm } from "node:fs/promises"
import { join } from "node:path"
import { activeHistory } from "../agent/history"
import { appInfo } from "../app-info"
import { backgroundSessionDir } from "../config/paths"
import { asString, isRecord } from "../lib/json"
import { pendingToolCalls } from "../providers/conversation"
import { createNativeSessionLock, type NativeSessionLock } from "../native"
import { SessionRecorder } from "../sessions/recorder"
import { loadSession, summarize } from "../sessions/store"
import type { SessionSummary } from "../sessions/types"
import {
  effectiveStatus,
  findBackgroundSession,
  isProcessAlive,
  readBgLease,
  readBgState,
  removeBackgroundSession,
  releaseBgLease,
  writeBgControl,
  writeBgState,
  type BgControlAction,
  type BgState,
  type BgView,
  type EffectiveBgStatus,
} from "./state"

const HANDOFF_TIMEOUT_MS = 20_000
const STOP_GRACE_MS = 15_000

export interface TakeoverOutcome {
  summary: SessionSummary
  continueWork: boolean
  retryPendingTools: boolean
}

export function continueAfter(status: EffectiveBgStatus): boolean {
  switch (status) {
    case "running":
    case "handoff":
    case "died":
      return true
    case "needs_input":
    case "done":
    case "stopped":
    case "failed":
      return false
  }
}

function attachLockPath(sessionId: string): string {
  return join(backgroundSessionDir(sessionId), "attach.lock")
}

async function claimAttach(sessionId: string): Promise<void> {
  let file
  try {
    file = await open(attachLockPath(sessionId), "wx", 0o600)
  } catch (error) {
    if (isRecord(error) && asString(error.code) === "EEXIST") {
      const short = sessionId.slice(0, 8)
      throw new Error(
        `another client is already attaching to ${short}; if that attach crashed, run "${appInfo.name} bg clear ${short}"`,
        { cause: error },
      )
    }
    throw error
  }
  await file.close()
}

function releaseAttach(sessionId: string): Promise<void> {
  return rm(attachLockPath(sessionId), { force: true })
}

async function requestWorker(state: BgState, action: BgControlAction, timeoutMs: number): Promise<BgState | undefined> {
  await writeBgControl(state.sessionId, {
    version: 1,
    workerId: state.workerId,
    requestId: crypto.randomUUID(),
    action,
    requestedAt: Date.now(),
  })
  const deadline = Date.now() + timeoutMs
  while (true) {
    const current = await readBgState(state.sessionId)
    if (!current) throw new Error(`background state for ${state.sessionId.slice(0, 8)} disappeared`)
    if (current.workerId !== state.workerId)
      throw new Error(`background worker for ${state.sessionId.slice(0, 8)} changed`)
    if (current.status !== "running" && !(await readBgLease(state.sessionId))) return current
    if (Date.now() > deadline) return undefined
    await Bun.sleep(50)
  }
}

export type StopOutcome = "stopped" | "timeout" | "not_running"

async function denyPendingRequest(state: BgState, owner: NativeSessionLock): Promise<void> {
  const loaded = await loadSession(state.sessionPath, owner)
  if (!loaded || loaded.meta.id !== state.sessionId)
    throw new Error(`the session file for ${state.sessionId.slice(0, 8)} is missing or mismatched`)
  const calls = pendingToolCalls(activeHistory(loaded.items), {
    provider: loaded.meta.provider,
    model: loaded.meta.model,
  })
  if (calls.length === 0) throw new Error(`session ${state.sessionId.slice(0, 8)} has no pending request to deny`)

  let recorderError: string | undefined
  const recorder = new SessionRecorder((message) => {
    recorderError = message
  })
  recorder.attach(state.sessionPath, owner)
  for (const call of calls) {
    const approval = loaded.events.findLast(
      (event) => event.type === "approval_requested" && event.callId === call.callId,
    )
    if (loaded.events.some((event) => event.type === "elicitation_requested" && event.callId === call.callId)) {
      recorder.event({ type: "elicitation_resolved", callId: call.callId })
    }
    const output = "User stopped the background session before answering the pending request."
    recorder.item({ type: "tool_result", callId: call.callId, output })
    recorder.event({
      type: "tool_finished",
      callId: call.callId,
      tool: call.name,
      title: approval?.type === "approval_requested" ? approval.title : JSON.stringify(call.args),
      readOnly: approval?.type === "approval_requested" ? approval.readOnly : false,
      output,
      denial: "user",
    })
  }
  await recorder.flush()
  if (recorderError) throw new Error(recorderError)

  const verified = await loadSession(state.sessionPath, owner)
  if (!verified) throw new Error(`the session file for ${state.sessionId.slice(0, 8)} became unreadable`)
  const remaining = pendingToolCalls(activeHistory(verified.items), {
    provider: verified.meta.provider,
    model: verified.meta.model,
  })
  if (remaining.length > 0) throw new Error(`the pending request for ${state.sessionId.slice(0, 8)} was not denied`)
}

async function waitForRelease(state: BgState, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const lease = await readBgLease(state.sessionId)
    if (lease && lease.workerId !== state.workerId) throw new Error("background ownership changed")
    if (!lease || !isProcessAlive(state.pid)) return
    if (Date.now() >= deadline) throw new Error("worker has not released its lease before the deadline")
    await Bun.sleep(100)
  }
}

async function stopWaitingSession(state: BgState): Promise<void> {
  await waitForRelease(state, STOP_GRACE_MS)
  const owner = createNativeSessionLock(state.sessionPath)
  try {
    const current = await readBgState(state.sessionId)
    if (!current || current.workerId !== state.workerId || current.status !== "needs_input") {
      throw new Error(`background ownership for ${state.sessionId.slice(0, 8)} changed`)
    }
    const lease = await readBgLease(state.sessionId)
    if (lease && (lease.workerId !== state.workerId || isProcessAlive(current.pid))) {
      throw new Error("worker has not released its lease")
    }
    await denyPendingRequest(state, owner)
    await writeBgState({
      ...state,
      updatedAt: Date.now(),
      status: "stopped",
      activity: "stopped",
      detail: "pending request denied when the background session was stopped",
    })
    if (lease) await releaseBgLease(state.sessionId, state.workerId)
  } finally {
    owner.close()
  }
}

export async function stopBackgroundWorker(view: BgView): Promise<StopOutcome> {
  await claimAttach(view.state.sessionId)
  try {
    if (view.effective === "needs_input") {
      await stopWaitingSession(view.state)
      return "stopped"
    }
    if (view.effective !== "running") return "not_running"
    const final = await requestWorker(view.state, "stop", STOP_GRACE_MS)
    if (!final) return "timeout"
    if (final.status === "stopped") return "stopped"
    if (final.status === "needs_input") {
      await stopWaitingSession(final)
      return "stopped"
    }
    return "not_running"
  } finally {
    await releaseAttach(view.state.sessionId)
  }
}

export async function handoffFromWorker(state: BgState): Promise<BgState> {
  const final = await requestWorker(state, "handoff", HANDOFF_TIMEOUT_MS)
  if (final) return final
  throw new Error(`the background worker did not acknowledge the handoff; check ${state.log}`)
}

export async function takeOverBackgroundSession(id: string): Promise<TakeoverOutcome> {
  const found = await findBackgroundSession(id)
  if (!found) throw new Error(`no background session matches ${id}`)
  const sessionId = found.state.sessionId
  await claimAttach(sessionId)
  try {
    const final = found.effective === "running" ? await handoffFromWorker(found.state) : found.state
    const effective = effectiveStatus(final, isProcessAlive(final.pid))
    await waitForRelease(final, HANDOFF_TIMEOUT_MS)
    const owner = createNativeSessionLock(final.sessionPath)
    try {
      const current = await readBgState(sessionId)
      if (!current || current.workerId !== final.workerId) throw new Error("background ownership changed")
      const lease = await readBgLease(sessionId)
      if (lease && (lease.workerId !== final.workerId || isProcessAlive(final.pid))) {
        throw new Error("worker has not released its lease")
      }
      const summary = await summarize(final.sessionPath)
      if (!summary || summary.id !== sessionId)
        throw new Error(`the session file for ${sessionId.slice(0, 8)} is missing or mismatched`)
      await removeBackgroundSession(sessionId)
      return {
        summary,
        continueWork: continueAfter(effective),
        retryPendingTools: effective === "needs_input",
      }
    } finally {
      owner.close()
    }
  } catch (error) {
    await releaseAttach(sessionId)
    throw error
  }
}
