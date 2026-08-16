import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type RGBA,
  type TextRenderable,
} from "@opentui/core"
import type { AgentState } from "../../../agent/events"
import type { PermissionMode } from "../../../permissions/types"
import { occupiedContext, type ThinkingEffort, type Usage } from "../../../providers/types"
import { redactText } from "../../../secrets/redactor"
import { formatDuration, formatTokens } from "../lib/format"
import { label, row } from "../lib/renderables"
import { spinnerGlyph, spinnerHandle } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export const STATUS_ROWS = 1

const WIDE = 64
type TurnOutcome = "completed" | "failed" | "interrupted"

function modeColor(mode: PermissionMode): RGBA {
  if (mode === "plan") return COLORS.success
  if (mode === "yolo") return COLORS.error
  if (mode === "normal") return COLORS.accent
  return COLORS.warning
}

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly backgroundLabel: TextRenderable
  private readonly modeLabel: TextRenderable
  private readonly meta: TextRenderable
  private readonly spinner = spinnerHandle(() => this.render())
  private state: AgentState = "idle"
  private hint: string | undefined
  private loading: string | undefined
  private notice: string | undefined
  private contextTokens: number | undefined
  private contextWindow: number | undefined
  private turnStartedAt: number | undefined
  private turnElapsed: string | undefined
  private turnOutcome: TurnOutcome | undefined
  private model: string

  constructor(
    ctx: RenderContext,
    model: string,
    private thinking: ThinkingEffort | undefined,
    private mode: PermissionMode,
  ) {
    this.model = redactText(model)
    this.view = row(ctx, { height: STATUS_ROWS, paddingLeft: 2, paddingRight: 2 })
    this.activity = label(ctx, { content: "", flexGrow: 1, flexShrink: 1, minWidth: 0 })
    this.backgroundLabel = label(ctx, { content: "", flexShrink: 1, minWidth: 0, marginLeft: 1 })
    this.modeLabel = label(ctx, { content: "", flexShrink: 1, minWidth: 0, marginLeft: 1 })
    this.meta = label(ctx, {
      content: this.model,
      flexShrink: 1,
      minWidth: 0,
      marginLeft: 1,
      color: COLORS.faint,
    })
    this.view.add(this.activity)
    this.view.add(this.backgroundLabel)
    this.view.add(this.meta)
    this.view.add(this.modeLabel)
    this.renderMode()
    this.view.onSizeChange = () => {
      this.renderMeta()
      this.render()
    }
    this.view.on(RenderableEvents.DESTROYED, () => this.spinner.stop())
    this.render()
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
    this.renderMode()
  }

  setModel(model: string): void {
    this.model = redactText(model)
    this.renderMeta()
  }

  setThinking(thinking: ThinkingEffort | undefined): void {
    this.thinking = thinking
    this.renderMeta()
  }

  setBackground(summary: string | undefined): void {
    this.backgroundLabel.content =
      summary === undefined ? "" : new StyledText([paint(COLORS.agent, summary), muted(" ·")])
  }

  private renderMode(): void {
    this.modeLabel.content = new StyledText([muted("· "), paint(modeColor(this.mode), this.mode)])
  }

  setState(state: AgentState): void {
    if (this.state === "idle" && state !== "idle") {
      this.turnStartedAt = Date.now()
      this.turnElapsed = undefined
      this.turnOutcome = undefined
    }
    if (this.state !== "idle" && state === "idle") {
      this.turnElapsed = this.turnStartedAt === undefined ? undefined : formatDuration(Date.now() - this.turnStartedAt)
      this.turnStartedAt = undefined
    }
    this.state = state
    this.loading = undefined
    this.notice = undefined
    this.toggleSpinner(this.busy)
    this.render()
  }

  setLoading(loading: string | undefined): void {
    this.loading = loading === undefined ? undefined : redactText(loading)
    this.notice = undefined
    this.toggleSpinner(loading !== undefined)
    this.render()
  }

  setHint(hint: string | undefined): void {
    if (this.hint === hint) return
    this.hint = hint
    this.render()
  }

  setNotice(notice: string): void {
    this.notice = redactText(notice)
    this.toggleSpinner(false)
    this.render()
  }

  clearNotice(): void {
    this.notice = undefined
    this.toggleSpinner(this.loading !== undefined || this.busy)
    this.render()
  }

  private get busy(): boolean {
    return (
      this.state === "streaming" ||
      this.state === "running_hook" ||
      this.state === "running_tool" ||
      this.state === "compacting"
    )
  }

  resetUsage(): void {
    this.contextTokens = undefined
    this.renderMeta()
  }

  resetTurnElapsed(): void {
    this.turnStartedAt = undefined
    this.turnElapsed = undefined
    this.turnOutcome = undefined
    this.render()
  }

  setTurnOutcome(outcome: TurnOutcome): void {
    this.turnOutcome = outcome
  }

  setUsage(context: Usage | undefined): void {
    if (context) this.contextTokens = occupiedContext(context)
    this.renderMeta()
  }

  setContextWindow(window: number | undefined): void {
    this.contextWindow = window
    this.renderMeta()
  }

  private renderMeta(): void {
    const thinking = this.thinking ? ` · ${this.thinking === "none" ? "thinking off" : this.thinking}` : ""
    const tokens = this.contextTokens
    if (tokens === undefined) {
      this.meta.content = `${this.model}${thinking}`
      return
    }

    const share = this.contextWindow ? ` (${Math.round((tokens / this.contextWindow) * 100)}%)` : ""
    this.meta.content = `${this.model}${thinking} · ${formatTokens(tokens)}${share}`
  }

  private toggleSpinner(active: boolean): void {
    if (active) this.spinner.start()
    else this.spinner.stop()
  }

  private render(): void {
    this.activity.content = this.content()
  }

  private content(): StyledText {
    if (this.hint) return new StyledText([muted(this.hint)])
    if (this.notice) return new StyledText([muted(this.notice)])
    if (this.loading) {
      return new StyledText([paint(COLORS.agent, spinnerGlyph()), muted(` ${this.loading}`)])
    }
    if (this.state === "awaiting_approval") {
      return new StyledText([paint(COLORS.warning, "!"), muted(" Approval needed · choose above")])
    }
    if (this.state === "awaiting_input") {
      return new StyledText([paint(COLORS.agent, "?"), muted(" Input needed · answer above")])
    }
    if (this.state !== "idle") {
      const hint = this.view.width > WIDE ? " · Esc interrupt" : ""
      const activity =
        this.state === "compacting" ? "Compacting context" : this.state === "running_hook" ? "Running hooks" : "Working"
      return new StyledText([paint(COLORS.agent, spinnerGlyph()), muted(` ${activity}${hint}`)])
    }
    if (this.turnElapsed && this.turnOutcome === "completed") {
      return new StyledText([paint(COLORS.success, "✓"), muted(` Finished in ${this.turnElapsed}`)])
    }
    if (this.turnElapsed && this.turnOutcome === "failed") {
      return new StyledText([paint(COLORS.error, "x"), muted(` Failed after ${this.turnElapsed}`)])
    }
    if (this.turnElapsed && this.turnOutcome === "interrupted") {
      return new StyledText([paint(COLORS.warning, "!"), muted(` Interrupted after ${this.turnElapsed}`)])
    }
    return new StyledText([muted("")])
  }
}
