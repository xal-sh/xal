import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type RGBA,
  type TextRenderable,
} from "@opentui/core"
import type { AgentState } from "../../../agent/events"
import type { GoalSnapshot } from "../../../goals/types"
import { formatTokens } from "../../../lib/format"
import type { PermissionMode } from "../../../permissions/types"
import { occupiedContext, type ThinkingEffort, type Usage } from "../../../providers/types"
import { redactText } from "../../../secrets/redactor"
import { FOOTER_ICON_WIDTH, FOOTER_RIGHT_PADDING, FOOTER_TEXT_COLUMN } from "../lib/footer-grid"
import { formatDuration } from "../lib/format"
import { label, row } from "../lib/renderables"
import { spinnerGlyph, spinnerHandle } from "../lib/spinner"
import { COLORS } from "../theme/colors"
import { muted, paint } from "../theme/styles"

export const STATUS_ROWS = 1

const WIDE = 64
type GoalIndicator = { status: "active"; startedAt: number } | { status: "suspended" }
type TurnOutcome = "completed" | "failed" | "interrupted"

function modeColor(mode: PermissionMode): RGBA {
  if (mode === "plan") return COLORS.success
  if (mode === "yolo") return COLORS.error
  if (mode === "normal") return COLORS.accent
  return COLORS.warning
}

function alignedText(text: string): StyledText {
  return new StyledText([muted(`${" ".repeat(FOOTER_ICON_WIDTH)}${text}`)])
}

export class StatusBar {
  readonly view: BoxRenderable
  private readonly activity: TextRenderable
  private readonly goalLabel: TextRenderable
  private readonly modeLabel: TextRenderable
  private readonly meta: TextRenderable
  private readonly spinner = spinnerHandle(() => this.render())
  private goal: GoalIndicator | undefined
  private goalTimer: ReturnType<typeof setInterval> | undefined
  private state: AgentState = "idle"
  private hint: string | undefined
  private loading: string | undefined
  private notice: string | undefined
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private contextTokens: number | undefined
  private contextWindow: number | undefined
  private turnStartedAt: number | undefined
  private turnElapsed: string | undefined
  private turnOutcome: TurnOutcome | undefined
  private model: string
  private metrics: string | undefined

  constructor(
    ctx: RenderContext,
    model: string,
    private thinking: ThinkingEffort | undefined,
    private mode: PermissionMode,
  ) {
    this.model = redactText(model)
    this.view = row(ctx, {
      height: STATUS_ROWS,
      paddingLeft: FOOTER_TEXT_COLUMN - FOOTER_ICON_WIDTH,
      paddingRight: FOOTER_RIGHT_PADDING,
    })
    this.activity = label(ctx, { content: "", flexGrow: 1, flexShrink: 1 })
    this.goalLabel = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    this.modeLabel = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    this.meta = label(ctx, {
      content: this.model,
      flexShrink: 0,
      marginLeft: 1,
      color: COLORS.faint,
    })
    this.view.add(this.activity)
    this.view.add(this.goalLabel)
    this.view.add(this.meta)
    this.view.add(this.modeLabel)
    this.renderMode()
    this.view.onSizeChange = () => {
      this.renderMeta()
      this.render()
    }
    this.view.on(RenderableEvents.DESTROYED, () => {
      this.spinner.stop()
      this.stopGoalTimer()
      this.stopNoticeTimer()
    })
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

  resetGoal(): void {
    this.goal = undefined
    this.stopGoalTimer()
    this.renderGoal()
  }

  setGoal(goal: GoalSnapshot): void {
    switch (goal.status) {
      case "active":
        this.goal = { status: "active", startedAt: goal.startedAt }
        this.startGoalTimer()
        this.renderGoal()
        return
      case "suspended":
        this.goal = { status: "suspended" }
        this.stopGoalTimer()
        this.renderGoal()
        return
      case "achieved":
      case "impossible":
      case "cleared":
        this.resetGoal()
        return
    }
    const exhaustive: never = goal
    return exhaustive
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
    this.stopNoticeTimer()
    this.toggleSpinner(this.busy)
    this.render()
  }

  setLoading(loading: string | undefined): void {
    this.loading = loading === undefined ? undefined : redactText(loading)
    if (loading !== undefined) {
      this.notice = undefined
      this.stopNoticeTimer()
    }
    this.toggleSpinner(loading !== undefined)
    this.render()
  }

  setHint(hint: string | undefined): void {
    if (this.hint === hint) return
    this.hint = hint
    this.render()
  }

  setNotice(notice: string): void {
    this.stopNoticeTimer()
    this.notice = redactText(notice)
    this.toggleSpinner(false)
    this.render()
  }

  setMetrics(metrics: string | undefined): void {
    this.metrics = metrics === undefined ? undefined : redactText(metrics)
    this.render()
  }

  flashNotice(notice: string, durationMs = 2_500): void {
    this.setNotice(notice)
    this.noticeTimer = setTimeout(() => this.clearNotice(), durationMs)
    this.noticeTimer.unref()
  }

  clearNotice(): void {
    this.stopNoticeTimer()
    this.notice = undefined
    this.toggleSpinner(this.loading !== undefined || this.busy)
    this.render()
  }

  private get busy(): boolean {
    switch (this.state) {
      case "streaming":
      case "running_hook":
      case "running_tool":
      case "compacting":
      case "evaluating_goal":
        return true
      case "idle":
      case "awaiting_approval":
      case "awaiting_input":
        return false
    }
    const exhaustive: never = this.state
    return exhaustive
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

  private renderGoal(): void {
    const goal = this.goal
    if (!goal) {
      this.goalLabel.content = ""
      return
    }
    switch (goal.status) {
      case "active":
        this.goalLabel.content = new StyledText([
          paint(COLORS.agent, "◎"),
          muted(` goal ${formatDuration(Date.now() - goal.startedAt)} ·`),
        ])
        return
      case "suspended":
        this.goalLabel.content = new StyledText([paint(COLORS.warning, "◎"), muted(" goal suspended ·")])
        return
    }
    const exhaustive: never = goal
    return exhaustive
  }

  private startGoalTimer(): void {
    if (this.goalTimer) return
    this.goalTimer = setInterval(() => this.renderGoal(), 1_000)
  }

  private stopGoalTimer(): void {
    if (this.goalTimer) clearInterval(this.goalTimer)
    this.goalTimer = undefined
  }

  private stopNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
  }

  private toggleSpinner(active: boolean): void {
    if (active) this.spinner.start()
    else this.spinner.stop()
  }

  private render(): void {
    this.activity.content = this.content()
  }

  private busyContent(activity: string): StyledText {
    const hint = this.view.width > WIDE ? " · Esc interrupt" : ""
    return new StyledText([paint(COLORS.agent, spinnerGlyph()), muted(` ${activity}${hint}`)])
  }

  private stateContent(): StyledText | undefined {
    switch (this.state) {
      case "awaiting_approval":
        return new StyledText([paint(COLORS.warning, "!"), muted(" Approval needed · choose above")])
      case "awaiting_input":
        return new StyledText([paint(COLORS.agent, "?"), muted(" Input needed · answer above")])
      case "compacting":
        return this.busyContent("Compacting context")
      case "running_hook":
        return this.busyContent("Running hooks")
      case "evaluating_goal":
        return this.busyContent("Evaluating goal")
      case "streaming":
      case "running_tool":
        return this.busyContent("Working")
      case "idle":
        return undefined
    }
    const exhaustive: never = this.state
    return exhaustive
  }

  private content(): StyledText {
    if (this.hint) return alignedText(this.hint)
    if (this.notice) return alignedText(this.notice)
    if (this.loading) {
      return new StyledText([paint(COLORS.agent, spinnerGlyph()), muted(` ${this.loading}`)])
    }
    if (this.metrics) return new StyledText([muted(this.metrics)])
    const state = this.stateContent()
    if (state) return state
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
