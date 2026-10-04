import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { backgroundSessionDir, backgroundSessionsDir } from "../config/paths"
import { isMissingPathError } from "../lib/error"
import { readJsonFile, writeNewSecureText, writeSecureJson } from "../lib/fs"
import { asNumber, asString, isRecord } from "../lib/json"

export type BgStatus = "running" | "done" | "needs_input" | "failed" | "stopped" | "handoff"

export type EffectiveBgStatus = BgStatus | "died"

export function isBgStatus(value: string): value is BgStatus {
  switch (value) {
    case "running":
    case "done":
    case "needs_input":
    case "failed":
    case "stopped":
    case "handoff":
      return true
    default:
      return false
  }
}

export interface BgState {
  version: 1
  appVersion: string
  sessionId: string
  sessionPath: string
  cwd: string
  title?: string
  log: string
  pid: number
  workerId: string
  startedAt: number
  updatedAt: number
  status: BgStatus
  activity?: string
  detail?: string
}

export interface BgView {
  state: BgState
  alive: boolean
  effective: EffectiveBgStatus
}

export type BgControlAction = "handoff" | "stop"

export interface BgControl {
  version: 1
  workerId: string
  requestId: string
  action: BgControlAction
  requestedAt: number
}

export interface BgLease {
  version: 1
  sessionId: string
  workerId: string
  createdAt: number
}

export function parseBgState(value: unknown): BgState | undefined {
  if (!isRecord(value)) return undefined
  if (asNumber(value.version) !== 1) return undefined
  const appVersion = asString(value.appVersion)
  const sessionId = asString(value.sessionId)
  const sessionPath = asString(value.sessionPath)
  const cwd = asString(value.cwd)
  const log = asString(value.log)
  const pid = asNumber(value.pid)
  const workerId = asString(value.workerId)
  const startedAt = asNumber(value.startedAt)
  const updatedAt = asNumber(value.updatedAt)
  const status = asString(value.status)
  if (
    appVersion === undefined ||
    sessionId === undefined ||
    sessionPath === undefined ||
    cwd === undefined ||
    log === undefined ||
    pid === undefined ||
    workerId === undefined ||
    startedAt === undefined ||
    updatedAt === undefined ||
    status === undefined ||
    !isBgStatus(status)
  ) {
    return undefined
  }
  const title = asString(value.title)
  const activity = asString(value.activity)
  const detail = asString(value.detail)
  if (
    (value.title !== undefined && title === undefined) ||
    (value.activity !== undefined && activity === undefined) ||
    (value.detail !== undefined && detail === undefined)
  ) {
    return undefined
  }
  return {
    version: 1,
    appVersion,
    sessionId,
    sessionPath,
    cwd,
    ...(title === undefined ? {} : { title }),
    log,
    pid,
    workerId,
    startedAt,
    updatedAt,
    status,
    ...(activity === undefined ? {} : { activity }),
    ...(detail === undefined ? {} : { detail }),
  }
}

export function parseBgControl(value: unknown): BgControl | undefined {
  if (!isRecord(value) || asNumber(value.version) !== 1) return undefined
  const workerId = asString(value.workerId)
  const requestId = asString(value.requestId)
  const action = asString(value.action)
  const requestedAt = asNumber(value.requestedAt)
  if (
    workerId === undefined ||
    requestId === undefined ||
    (action !== "handoff" && action !== "stop") ||
    requestedAt === undefined
  ) {
    return undefined
  }
  return { version: 1, workerId, requestId, action, requestedAt }
}

export function parseBgLease(value: unknown): BgLease | undefined {
  if (!isRecord(value) || asNumber(value.version) !== 1) return undefined
  const sessionId = asString(value.sessionId)
  const workerId = asString(value.workerId)
  const createdAt = asNumber(value.createdAt)
  if (sessionId === undefined || workerId === undefined || createdAt === undefined) return undefined
  return { version: 1, sessionId, workerId, createdAt }
}

export function backgroundStatePath(sessionId: string): string {
  return join(backgroundSessionDir(sessionId), "state.json")
}

export function backgroundLogPath(sessionId: string): string {
  return join(backgroundSessionDir(sessionId), "worker.log")
}

export function backgroundControlPath(sessionId: string): string {
  return join(backgroundSessionDir(sessionId), "control.json")
}

export function backgroundLeasePath(sessionId: string): string {
  return join(backgroundSessionDir(sessionId), "lease.json")
}

export async function readBgState(sessionId: string): Promise<BgState | undefined> {
  const raw = await readJsonFile(backgroundStatePath(sessionId))
  if (raw === undefined) return undefined
  const state = parseBgState(raw)
  if (!state) throw new Error(`${backgroundStatePath(sessionId)} has an unsupported or malformed background state`)
  return state
}

export function writeBgState(state: BgState): Promise<void> {
  return writeSecureJson(backgroundStatePath(state.sessionId), state)
}

export async function readBgControl(sessionId: string): Promise<BgControl | undefined> {
  const raw = await readJsonFile(backgroundControlPath(sessionId))
  if (raw === undefined) return undefined
  const control = parseBgControl(raw)
  if (!control) throw new Error(`${backgroundControlPath(sessionId)} has a malformed worker request`)
  return control
}

export function writeBgControl(sessionId: string, control: BgControl): Promise<void> {
  return writeSecureJson(backgroundControlPath(sessionId), control)
}

export function removeBgControl(sessionId: string): Promise<void> {
  return rm(backgroundControlPath(sessionId), { force: true })
}

export async function readBgLease(sessionId: string): Promise<BgLease | undefined> {
  const raw = await readJsonFile(backgroundLeasePath(sessionId))
  if (raw === undefined) return undefined
  const lease = parseBgLease(raw)
  if (!lease || lease.sessionId !== sessionId)
    throw new Error(`${backgroundLeasePath(sessionId)} has a malformed lease`)
  return lease
}

export function claimBgLease(sessionId: string, workerId: string): Promise<void> {
  const lease: BgLease = { version: 1, sessionId, workerId, createdAt: Date.now() }
  return writeNewSecureText(backgroundLeasePath(sessionId), `${JSON.stringify(lease, null, 2)}\n`)
}

export async function assertBgLease(sessionId: string, workerId: string): Promise<void> {
  const lease = await readBgLease(sessionId)
  if (!lease || lease.workerId !== workerId)
    throw new Error(`background worker ${workerId} no longer owns ${sessionId}`)
}

export async function releaseBgLease(sessionId: string, workerId: string): Promise<void> {
  await assertBgLease(sessionId, workerId)
  await rm(backgroundLeasePath(sessionId))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isRecord(error) && asString(error.code) === "EPERM"
  }
}

export function effectiveStatus(state: BgState, alive: boolean): EffectiveBgStatus {
  return state.status === "running" && !alive ? "died" : state.status
}

function view(state: BgState): BgView {
  const alive = isProcessAlive(state.pid)
  return { state, alive, effective: effectiveStatus(state, alive) }
}

async function stateDirEntries(): Promise<string[]> {
  try {
    const entries = await readdir(backgroundSessionsDir(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
}

export async function listBackgroundSessions(): Promise<BgView[]> {
  const views: BgView[] = []
  for (const entry of await stateDirEntries()) {
    const state = await readBgState(entry)
    if (!state) continue
    if (state.sessionId !== entry) throw new Error(`background entry ${entry} belongs to session ${state.sessionId}`)
    views.push(view(state))
  }
  return views.toSorted((left, right) => right.state.updatedAt - left.state.updatedAt)
}

export async function findBackgroundSession(id: string): Promise<BgView | undefined> {
  const views = await listBackgroundSessions()
  const exact = views.find((candidate) => candidate.state.sessionId === id)
  if (exact) return exact
  const matches = views.filter((candidate) => candidate.state.sessionId.startsWith(id))
  if (matches.length > 1) throw new Error(`background session prefix ${id} is ambiguous`)
  return matches[0]
}

export async function liveBackgroundSession(sessionId: string): Promise<BgState | undefined> {
  const state = await readBgState(sessionId)
  if (!state || state.status !== "running" || !isProcessAlive(state.pid)) return undefined
  return state
}

export function removeBackgroundSession(sessionId: string): Promise<void> {
  return rm(backgroundSessionDir(sessionId), { recursive: true, force: true })
}

export async function clearBackgroundSessions(id?: string): Promise<string[]> {
  const removed: string[] = []
  if (id !== undefined) {
    const found = await findBackgroundSession(id)
    if (!found) throw new Error(`no background session matches ${id}`)
    if (found.alive) throw new Error(`session ${found.state.sessionId.slice(0, 8)} is still running; stop it first`)
    await removeBackgroundSession(found.state.sessionId)
    removed.push(found.state.sessionId)
    return removed
  }
  for (const entry of await listBackgroundSessions()) {
    if (entry.alive) continue
    await removeBackgroundSession(entry.state.sessionId)
    removed.push(entry.state.sessionId)
  }
  return removed
}
