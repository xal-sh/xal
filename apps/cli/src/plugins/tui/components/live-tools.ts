import type { BoxRenderable, RenderContext, TextRenderable } from "@opentui/core"
import { formatDuration } from "../lib/format"
import { column, label, row } from "../lib/renderables"
import { spinnerGlyph, spinnerHandle } from "../lib/spinner"
import { sanitize } from "../lib/text"
import { COLORS } from "../theme/colors"
import { commandLabel, liveStatus, type LivePhase } from "./tool-status"

const PREVIEW_LINES = 3
const PREVIEW_KEPT_CHARS = 4_000

interface LiveRow {
  view: BoxRenderable
  status: TextRenderable
  preview: BoxRenderable
  previewLabels: TextRenderable[]
  tool: string
  tail: string
  createdAt: number
  pausedAt: number | undefined
  pausedMs: number
  phase: LivePhase
}

export class LiveTools {
  readonly view: BoxRenderable
  private readonly rows = new Map<string, LiveRow>()
  private readonly spinner = spinnerHandle(() => this.render())
  private grouped = false

  constructor(
    private readonly ctx: RenderContext,
    private readonly onChange: () => void,
    private readonly backgroundShortcut: string | undefined,
  ) {
    this.view = column(ctx, {})
  }

  get height(): number {
    if (this.rows.size === 0) return 0
    let height = this.grouped ? 0 : 1
    for (const entry of this.rows.values()) height += 1 + entry.previewLabels.length
    return height
  }

  setGrouped(grouped: boolean): void {
    this.grouped = grouped
    this.view.marginTop = grouped ? 0 : 1
  }

  request(callId: string, tool: string, title: string, readOnly: boolean): void {
    this.add(callId, tool, title, readOnly, "requested")
  }

  start(callId: string, tool: string, title: string, readOnly: boolean): void {
    const existing = this.rows.get(callId)
    if (!existing) {
      this.add(callId, tool, title, readOnly, "running")
      return
    }
    existing.createdAt = Date.now()
    existing.pausedAt = undefined
    existing.pausedMs = 0
    existing.phase = "running"
    this.syncSpinner()
    this.render()
  }

  pause(callId: string): void {
    const entry = this.rows.get(callId)
    if (!entry || entry.phase !== "running") return
    entry.pausedAt = Date.now()
    entry.phase = "waiting"
    this.syncSpinner()
    this.render()
  }

  resume(callId: string): void {
    const entry = this.rows.get(callId)
    if (!entry || entry.phase !== "waiting" || entry.pausedAt === undefined) return
    entry.pausedMs += Date.now() - entry.pausedAt
    entry.pausedAt = undefined
    entry.phase = "running"
    this.syncSpinner()
    this.render()
  }

  update(callId: string, text: string): void {
    const entry = this.rows.get(callId)
    if (!entry) return
    entry.tail = (entry.tail + sanitize(text)).slice(-PREVIEW_KEPT_CHARS)
    const lines = entry.tail
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-PREVIEW_LINES)
    while (entry.previewLabels.length > lines.length) {
      const removed = entry.previewLabels.pop()!
      entry.preview.remove(removed)
      removed.destroyRecursively()
    }
    while (entry.previewLabels.length < lines.length) {
      const added = label(this.ctx, { content: "", color: COLORS.faint })
      entry.preview.add(added)
      entry.previewLabels.push(added)
    }
    lines.forEach((line, index) => {
      entry.previewLabels[index]!.content = line
    })
    this.sync()
  }

  finish(callId: string): string | undefined {
    const existing = this.rows.get(callId)
    if (!existing) return undefined
    const elapsed = existing.phase === "requested" ? undefined : formatDuration(this.elapsed(existing))
    this.rows.delete(callId)
    this.view.remove(existing.view)
    existing.view.destroyRecursively()
    this.syncSpinner()
    this.sync()
    return elapsed
  }

  clear(): void {
    if (this.rows.size === 0) return
    for (const entry of this.rows.values()) {
      this.view.remove(entry.view)
      entry.view.destroyRecursively()
    }
    this.rows.clear()
    this.spinner.stop()
    this.sync()
  }

  private add(callId: string, tool: string, title: string, readOnly: boolean, phase: LivePhase): void {
    const view = column(this.ctx, {})
    const header = row(this.ctx, { height: 1, alignItems: "center" })
    header.add(label(this.ctx, { content: readOnly ? ">" : "*", width: 2, color: COLORS.faint }))
    header.add(
      label(this.ctx, {
        content: commandLabel(tool, title),
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        color: COLORS.faint,
      }),
    )
    const status = label(this.ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    header.add(status)
    view.add(header)
    const preview = column(this.ctx, { paddingLeft: 2 })
    view.add(preview)
    this.view.add(view)
    this.rows.set(callId, {
      view,
      status,
      preview,
      previewLabels: [],
      tool,
      tail: "",
      createdAt: Date.now(),
      pausedAt: undefined,
      pausedMs: 0,
      phase,
    })
    this.sync()
    this.syncSpinner()
    this.render()
  }

  private elapsed(entry: LiveRow): number {
    return (entry.pausedAt ?? Date.now()) - entry.createdAt - entry.pausedMs
  }

  private syncSpinner(): void {
    if ([...this.rows.values()].some((entry) => entry.phase === "running")) {
      this.spinner.start()
      return
    }
    this.spinner.stop()
  }

  private sync(): void {
    this.view.visible = this.rows.size > 0
    this.onChange()
  }

  private render(): void {
    for (const entry of this.rows.values()) {
      const suffix =
        entry.tool === "bash" && entry.phase === "running" && this.backgroundShortcut
          ? ` · ${this.backgroundShortcut} background`
          : ""
      entry.status.content = liveStatus(entry.phase, formatDuration(this.elapsed(entry)), spinnerGlyph(), suffix)
    }
  }
}
