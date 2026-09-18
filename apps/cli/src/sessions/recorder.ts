import { appendFile, mkdir, readFile, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import { writeNewSecureText } from "../lib/fs"
import { isPersistable, parseRecord } from "./records"
import { loadSession } from "./store"
import type { SessionMeta, SessionRecord } from "./types"

function line(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`
}

interface ForkTarget {
  id: string
  parentId: string
  startedAt: number
  cwd: string
  provider: string
  profile: string
  model: string
  thinking: SessionMeta["thinking"]
  mode: SessionMeta["mode"]
  modeBeforePlan: SessionMeta["modeBeforePlan"]
}

type ForkState = Pick<ForkTarget, "cwd" | "provider" | "model" | "thinking" | "mode" | "modeBeforePlan"> & {
  profile?: string
}

function replayState(meta: SessionMeta, events: AgentEvent[]): ForkState {
  const state: ForkState = {
    cwd: meta.cwd,
    provider: meta.provider,
    profile: meta.profile,
    model: meta.model,
    thinking: meta.thinking,
    mode: meta.mode,
    modeBeforePlan: meta.modeBeforePlan,
  }
  for (const event of events) {
    if (event.type === "workspace_changed") state.cwd = event.cwd
    if (event.type === "model_changed") {
      state.provider = event.provider
      state.profile = event.profile
      state.model = event.model
    }
    if (event.type === "thinking_changed") state.thinking = event.thinking
    if (event.type === "mode_changed") {
      if (event.mode === "plan" && state.mode !== "plan") state.modeBeforePlan = state.mode
      if (event.mode !== "plan" && state.mode === "plan") state.modeBeforePlan = undefined
      state.mode = event.mode
    }
  }
  return state
}

function stateCorrections(recorded: ForkState, target: ForkState): AgentEvent[] {
  const events: AgentEvent[] = []
  if (recorded.cwd !== target.cwd) {
    events.push({ type: "workspace_changed", previous: recorded.cwd, cwd: target.cwd })
  }
  if (recorded.provider !== target.provider || recorded.profile !== target.profile || recorded.model !== target.model) {
    events.push({ type: "model_changed", provider: target.provider, profile: target.profile, model: target.model })
  }
  if (recorded.thinking !== target.thinking) events.push({ type: "thinking_changed", thinking: target.thinking })
  if (recorded.mode !== target.mode) {
    if (target.mode === "plan" && target.modeBeforePlan && recorded.mode !== target.modeBeforePlan) {
      events.push({ type: "mode_changed", mode: target.modeBeforePlan })
    }
    events.push({ type: "mode_changed", mode: target.mode })
  } else if (target.mode === "plan" && recorded.modeBeforePlan !== target.modeBeforePlan && target.modeBeforePlan) {
    events.push({ type: "mode_changed", mode: target.modeBeforePlan }, { type: "mode_changed", mode: "plan" })
  }
  return events
}

function sameState(left: ForkState, right: ForkState): boolean {
  return (
    left.cwd === right.cwd &&
    left.provider === right.provider &&
    left.profile === right.profile &&
    left.model === right.model &&
    left.thinking === right.thinking &&
    left.mode === right.mode &&
    left.modeBeforePlan === right.modeBeforePlan
  )
}

export class SessionRecorder {
  private path: string | undefined
  private pending: { meta: SessionMeta; cwd: string } | undefined
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  private failed = false

  constructor(private readonly onError: (message: string) => void) {}

  start(meta: SessionMeta, cwd: string): void {
    this.generation += 1
    this.path = undefined
    this.pending = { meta, cwd }
    this.failed = false
  }

  attach(path: string): void {
    this.generation += 1
    this.path = path
    this.pending = undefined
    this.failed = false
  }

  async flush(): Promise<void> {
    await this.queue
    if (this.failed) throw new Error("session recorder is unavailable")
  }

  async fork(target: ForkTarget, cwd: string): Promise<{ path: string; corrections: AgentEvent[] }> {
    await this.flush()
    if (!this.path) throw new Error("session has not been recorded")

    const source = await readFile(this.path, "utf8")
    if (!source.endsWith("\n")) throw new Error("session record has an incomplete tail")
    const records = source.split("\n").filter(Boolean).map(parseRecord)
    const first = records[0]
    if (!first || first.type !== "meta" || first.meta.id !== target.parentId) {
      throw new Error("session record does not match the fork parent")
    }
    if (records.slice(1).some((record) => record.type === "meta")) {
      throw new Error("session record contains duplicate metadata")
    }

    const sourceEvents = records.flatMap((record) => {
      if (record.type !== "event") return []
      const event = record.event
      if (event.type === "reasoning_routed" || event.type === "request_measured") return []
      return [event]
    })
    const corrections = stateCorrections(replayState(first.meta, sourceEvents), target)
    const meta: SessionMeta = {
      ...first.meta,
      id: target.id,
      parentId: target.parentId,
      startedAt: target.startedAt,
    }
    const firstNewline = source.indexOf("\n")
    const path = join(projectSessionsDir(cwd), `${target.id}.jsonl`)
    const correctionLines = corrections.map((event) => line({ type: "event", event })).join("")
    await writeNewSecureText(path, line({ type: "meta", meta }) + source.slice(firstNewline + 1) + correctionLines)
    const loaded = await loadSession(path)
    if (
      !loaded ||
      loaded.meta.id !== target.id ||
      loaded.meta.parentId !== target.parentId ||
      !sameState(replayState(loaded.meta, loaded.events), target)
    ) {
      await unlink(path)
      throw new Error("forked session did not pass validation")
    }
    this.path = path
    this.pending = undefined
    return { path, corrections }
  }

  item(item: HistoryItem): void {
    this.append({ type: "item", item })
  }

  event(event: AgentEvent): void {
    if (!isPersistable(event)) return
    this.append({ type: "event", event })
  }

  eventAndWait(event: AgentEvent): Promise<void> {
    if (!isPersistable(event)) return Promise.reject(new Error("session event cannot be persisted"))
    return this.appendAndWait({ type: "event", event })
  }

  private append(record: SessionRecord): void {
    if (this.failed) return
    void this.appendAndWait(record)
  }

  private appendAndWait(record: SessionRecord): Promise<void> {
    if (this.failed) return Promise.reject(new Error("session recorder is unavailable"))
    const generation = this.generation
    const pending = this.pending
    if (pending) {
      this.path = join(projectSessionsDir(pending.cwd), `${pending.meta.id}.jsonl`)
      this.pending = undefined
    }
    const path = this.path
    if (!path) return Promise.resolve()
    const writing = this.queue.then(() => {
      if (this.failed) throw new Error("session recorder is unavailable")
      return this.write(path, record, pending?.meta)
    })
    this.queue = writing.catch((error: unknown) => this.fail(error, generation))
    return writing
  }

  private async write(path: string, record: SessionRecord, meta: SessionMeta | undefined): Promise<void> {
    if (meta) await mkdir(dirname(path), { recursive: true })
    const payload = meta ? line({ type: "meta", meta }) + line(record) : line(record)
    await appendFile(path, payload, { mode: 0o600 })
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation || this.failed) return
    this.failed = true
    this.onError(`session not saved: ${describeError(error)}`)
  }
}
