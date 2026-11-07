import { constants } from "node:fs"
import { appendFile, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { AgentEvent } from "../agent/events"
import type { HistoryItem } from "../agent/history"
import { projectSessionsDir } from "../config/paths"
import { describeError } from "../lib/error"
import type { JsonObject } from "../lib/json"
import { writeNewSecureText } from "../lib/fs"
import { isPersistable, isRetiredEvent, parseRecord } from "./records"
import { loadSession } from "./store"
import { SessionWriter } from "./ownership"
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
  private writer: SessionWriter | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private failure: Error | undefined

  constructor(private readonly onError: (message: string) => void) {}

  get error(): Error | undefined {
    return this.failure
  }

  get unavailable(): boolean {
    return this.closed || this.failure !== undefined
  }

  start(meta: SessionMeta, cwd: string): void {
    if (this.path || this.pending || this.closing)
      throw new Error("close the current session recorder before starting another")
    this.pending = { meta, cwd }
    this.closed = false
    this.failure = undefined
  }

  attach(writer: SessionWriter): void {
    if (this.path || this.pending || this.closing)
      throw new Error("close the current session recorder before attaching another")
    this.writer = writer.transfer()
    this.path = this.writer.path
    this.closed = false
    this.failure = undefined
  }

  async flush(): Promise<void> {
    let pending
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
    if (this.failure) throw this.failure
    if (this.closed) throw new Error("session recorder is closed")
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.closed) return
    this.closed = true
    this.closing = this.queue
      .then(() => {
        if (this.failure) throw this.failure
      })
      .finally(() => {
        this.writer?.close()
        this.writer = undefined
        this.path = undefined
        this.pending = undefined
        this.closing = undefined
      })
    return this.closing
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
      if (isRetiredEvent(event)) return []
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
    const writer = SessionWriter.acquire(path)
    try {
      await writeNewSecureText(path, line({ type: "meta", meta }) + source.slice(firstNewline + 1) + correctionLines)
      const loaded = await loadSession(path, writer)
      if (
        !loaded ||
        loaded.meta.id !== target.id ||
        loaded.meta.parentId !== target.parentId ||
        !sameState(replayState(loaded.meta, loaded.events), target)
      ) {
        await unlink(path)
        throw new Error("forked session did not pass validation")
      }
      await this.flush()
      this.writer?.close()
      this.writer = writer.transfer()
      this.path = this.writer.path
      this.pending = undefined
      return { path: this.path, corrections }
    } finally {
      writer.close()
    }
  }

  promptState(id: string, state: JsonObject): Promise<void> {
    return this.appendAndWait({ type: "prompt_state", id, state })
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
    if (this.unavailable) return
    void this.appendAndWait(record)
  }

  private appendAndWait(record: SessionRecord): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error("session recorder is closed"))
    const pending = this.pending
    if (pending) {
      this.path = join(projectSessionsDir(pending.cwd), `${pending.meta.id}.jsonl`)
      this.pending = undefined
    }
    const path = this.path
    if (!path) return Promise.reject(new Error("session recorder has not been started"))
    const writing = this.queue.then(() => {
      if (this.failure) throw this.failure
      return this.write(path, record, pending?.meta)
    })
    this.queue = writing.catch((error: unknown) => this.fail(error))
    return writing
  }

  private async write(path: string, record: SessionRecord, meta: SessionMeta | undefined): Promise<void> {
    if (meta) {
      this.writer = SessionWriter.acquire(path)
      await writeNewSecureText(this.writer.path, line({ type: "meta", meta }) + line(record))
      return
    }
    if (!this.writer) throw new Error("session recorder does not own the transcript")
    this.writer.assert(path)
    await appendFile(this.writer.path, line(record), { flag: constants.O_WRONLY | constants.O_APPEND })
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = new Error(`session not saved: ${describeError(error)}`, { cause: error })
    this.onError(this.failure.message)
  }
}
