import {
  RGBA,
  StyledText,
  TextAttributes,
  type BoxRenderable,
  type RenderContext,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core"
import {
  buildUsageActivity,
  formatUsageNumber,
  formatUsagePercent,
  nextUsageActivityView,
  type UsageActivity,
  type UsageActivityMetric,
  type UsageActivityView,
} from "../../../usage/activity"
import type { ProviderUsageSummary } from "../../../usage/summary"
import { column, label, row } from "../lib/renderables"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

const WEEK_COUNT = 52
const DAY_COUNT = 7
const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const EMPTY_GLYPH = "□"
const ACTIVE_GLYPH = "■"

interface ChartWindow {
  dates: number[]
  values: number[]
  firstColumn: number
  shownColumns: number
  columnOffsets: number[]
}

function utcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS
}

function dateKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function chartWindow(activity: UsageActivity, now: Date, width: number): ChartWindow {
  const today = utcDay(now)
  const start = today - now.getUTCDay() - (WEEK_COUNT - 1) * DAY_COUNT
  const dates = Array.from({ length: WEEK_COUNT * DAY_COUNT }, (_, index) => start + index)
  const byDate = new Map(activity.days.map((day) => [day.date, day.tokens]))
  const values = dates.map((day) => byDate.get(dateKey(day)) ?? 0)
  const innerWidth = Math.max(1, width - 6)
  const shownColumns = Math.max(1, Math.min(WEEK_COUNT, innerWidth - 4))
  const gapCount = Math.max(0, Math.min(shownColumns - 1, innerWidth - 4 - shownColumns))
  const columnOffsets: number[] = []
  let offset = 0
  for (let column = 0; column < shownColumns; column++) {
    if (column > 0) {
      const gap = column - 1
      const previous = Math.floor((gap * gapCount) / (shownColumns - 1))
      const next = Math.floor(((gap + 1) * gapCount) / (shownColumns - 1))
      offset += next > previous ? 2 : 1
    }
    columnOffsets.push(offset)
  }
  return { dates, values, shownColumns, columnOffsets, firstColumn: WEEK_COUNT - shownColumns }
}

function dailyLevels(values: number[]): number[] {
  const peak = Math.max(0, ...values)
  return values.map((value) => {
    if (value <= 0 || peak <= 0) return 0
    if (value * 4 > peak * 3) return 4
    if (value * 2 > peak) return 3
    if (value * 4 > peak) return 2
    return 1
  })
}

function activityColors(): RGBA[] {
  return [0, 0.35, 0.55, 0.75, 1].map((strength) =>
    RGBA.fromValues(
      COLORS.background.r + (COLORS.agent.r - COLORS.background.r) * strength,
      COLORS.background.g + (COLORS.agent.g - COLORS.background.g) * strength,
      COLORS.background.b + (COLORS.agent.b - COLORS.background.b) * strength,
    ),
  )
}

function weeklyValues(values: number[]): number[] {
  return Array.from({ length: WEEK_COUNT }, (_, week) =>
    values.slice(week * DAY_COUNT, week * DAY_COUNT + DAY_COUNT).reduce((total, value) => total + value, 0),
  )
}

function barHeights(values: number[]): number[] {
  const peak = Math.max(0, ...values)
  return values.map((value) => {
    if (value <= 0 || peak <= 0) return 0
    return Math.ceil((value * DAY_COUNT) / peak)
  })
}

function monthLabels(window: ChartWindow): string {
  const cells = Array.from({ length: window.columnOffsets.at(-1)! + 1 }, () => " ")
  let lastEnd = 0
  for (let column = window.firstColumn; column < WEEK_COUNT; column++) {
    const date = new Date(window.dates[column * DAY_COUNT]! * DAY_MS)
    if (date.getUTCDate() > 7) continue
    const month = MONTHS[date.getUTCMonth()]!
    const offset = window.columnOffsets[column - window.firstColumn]!
    if (offset < lastEnd || offset + month.length > cells.length) continue
    for (let index = 0; index < month.length; index++) cells[offset + index] = month[index]!
    lastEnd = offset + month.length + 1
  }
  return `    ${cells.join("")}`
}

function streakLabel(activity: UsageActivity): string {
  if (activity.currentStreakDays === activity.longestStreakDays) return `${activity.currentStreakDays}d`
  return `${activity.currentStreakDays}d (best ${activity.longestStreakDays}d)`
}

function metricLabel(metric: UsageActivityMetric): string {
  return metric === "total" ? "Total usage" : "Uncached usage"
}

interface SummaryField {
  label: string
  value: string
  suffix?: string
}

function summaryRows(activity: UsageActivity, width: number): StyledText[] {
  const fields: SummaryField[] = [
    { label: "Today", value: formatUsageNumber(activity.todayTokens) },
    { label: "Yesterday", value: formatUsageNumber(activity.yesterdayTokens) },
    { label: "Session", value: formatUsageNumber(activity.sessionTokens) },
    { label: "Last 7d", value: formatUsageNumber(activity.weeklyTokens) },
    { label: "Lifetime", value: formatUsageNumber(activity.lifetimeTokens) },
    { label: "Peak day", value: formatUsageNumber(activity.peakDailyTokens) },
    activity.metric === "total"
      ? { label: "Uncached", value: formatUsageNumber(activity.uncachedLifetimeTokens) }
      : { label: "Total", value: formatUsageNumber(activity.totalLifetimeTokens) },
    {
      label: "Cache",
      value: formatUsageNumber(activity.cacheReadTokens),
      suffix: ` (${formatUsagePercent(activity.cacheReadTokens, activity.inputTokens)})`,
    },
    { label: "Requests", value: formatUsageNumber(activity.requests) },
    { label: "Streak", value: streakLabel(activity) },
  ]
  const columns = width >= 100 ? 4 : 2
  const contentWidth = Math.max(1, Math.min(107, width - 6))
  const cellWidth = Math.max(1, Math.floor((contentWidth - 1 - (columns - 1) * 2) / columns))
  const rows: StyledText[] = []
  for (let offset = 0; offset < fields.length; offset += columns) {
    const chunks: TextChunk[] = [muted(" ")]
    for (let index = 0; index < columns; index++) {
      const field = fields[offset + index]
      if (!field) break
      if (index > 0) chunks.push(muted("  "))
      chunks.push(muted(`${field.label} `), paint(COLORS.warning, field.value))
      if (field.suffix) chunks.push(muted(field.suffix))
      const length = field.label.length + 1 + field.value.length + (field.suffix?.length ?? 0)
      if (index < columns - 1 && length < cellWidth) chunks.push(muted(" ".repeat(cellWidth - length)))
    }
    rows.push(new StyledText(chunks))
  }
  return rows
}

function hasColumnGap(window: ChartWindow, index: number): boolean {
  return index > 0 && window.columnOffsets[index]! > window.columnOffsets[index - 1]! + 1
}

function chartRows(window: ChartWindow, view: UsageActivityView, now: Date): StyledText[] {
  const rows: StyledText[] = []
  if (view === "daily") {
    const levels = dailyLevels(window.values)
    const colors = activityColors()
    const today = utcDay(now)
    for (let rowIndex = 0; rowIndex < DAY_COUNT; rowIndex++) {
      const chunks: TextChunk[] = [muted(` ${WEEKDAYS[rowIndex]} `)]
      for (let column = window.firstColumn; column < WEEK_COUNT; column++) {
        const shownIndex = column - window.firstColumn
        if (hasColumnGap(window, shownIndex)) chunks.push(muted(" "))
        const index = column * DAY_COUNT + rowIndex
        if (window.dates[index]! > today) {
          chunks.push(muted(" "))
          continue
        }
        const level = levels[index]!
        chunks.push(level === 0 ? muted(EMPTY_GLYPH) : paint(colors[level]!, ACTIVE_GLYPH))
      }
      rows.push(new StyledText(chunks))
    }
    return rows
  }

  const weeks = weeklyValues(window.values)
  const totals =
    view === "weekly" ? weeks : weeks.map((_, index) => weeks.slice(0, index + 1).reduce((a, b) => a + b, 0))
  const heights = barHeights(totals)
  for (let rowIndex = 0; rowIndex < DAY_COUNT; rowIndex++) {
    const gutter = rowIndex === 0 ? "max " : rowIndex === DAY_COUNT - 1 ? "  0 " : "    "
    const chunks: TextChunk[] = [muted(gutter)]
    for (let column = window.firstColumn; column < WEEK_COUNT; column++) {
      const shownIndex = column - window.firstColumn
      if (hasColumnGap(window, shownIndex)) chunks.push(muted(" "))
      chunks.push(heights[column]! >= DAY_COUNT - rowIndex ? paint(COLORS.agent, "█") : muted(" "))
    }
    rows.push(new StyledText(chunks))
  }
  return rows
}

function chartCaption(window: ChartWindow, view: UsageActivityView): StyledText {
  if (view === "daily") {
    const colors = activityColors()
    return new StyledText([
      muted("    Less "),
      muted(EMPTY_GLYPH),
      muted(" "),
      paint(colors[1]!, ACTIVE_GLYPH),
      muted(" "),
      paint(colors[2]!, ACTIVE_GLYPH),
      muted(" "),
      paint(colors[3]!, ACTIVE_GLYPH),
      muted(" "),
      paint(colors[4]!, ACTIVE_GLYPH),
      muted(" More"),
    ])
  }
  const weeks = weeklyValues(window.values)
  const value = view === "weekly" ? Math.max(0, ...weeks) : weeks.reduce((total, week) => total + week, 0)
  const label = view === "weekly" ? "Each column = 1 week · tallest " : "Running total · top "
  return new StyledText([muted(`    ${label}`), paint(COLORS.warning, formatUsageNumber(value))])
}

function viewsFooter(active: UsageActivityView): StyledText {
  const chunks: TextChunk[] = [muted("    ")]
  const views: UsageActivityView[] = ["daily", "weekly", "cumulative"]
  for (let index = 0; index < views.length; index++) {
    const view = views[index]!
    if (index > 0) chunks.push(muted(" · "))
    chunks.push(view === active ? paint(COLORS.warning, view) : muted(view))
  }
  return new StyledText(chunks)
}

export class UsagePopover {
  readonly view: BoxRenderable
  private readonly title: TextRenderable
  private readonly provider: TextRenderable
  private readonly activityTitle: TextRenderable
  private readonly summaries: TextRenderable[] = []
  private readonly months: TextRenderable
  private readonly chart: TextRenderable[] = []
  private readonly caption: TextRenderable
  private readonly views: TextRenderable
  private readonly hint: TextRenderable
  private summary: ProviderUsageSummary | undefined
  private activityView: UsageActivityView = "daily"
  private metric: UsageActivityMetric = "total"
  private providerName: string | undefined
  private summaryRowCount = 4

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return this.summaryRowCount + 16
  }

  constructor(
    ctx: RenderContext,
    private readonly onChange: () => void,
    private readonly availableWidth: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.view = column(ctx, {
      visible: false,
      height: 19,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.agent),
    })

    const header = row(ctx, { height: 1 })
    this.title = label(ctx, {
      content: "",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      attributes: TextAttributes.BOLD,
      color: COLORS.agent,
    })
    this.provider = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    header.add(this.title)
    header.add(this.provider)
    this.view.add(header)

    this.activityTitle = label(ctx, { content: "", attributes: TextAttributes.BOLD })
    this.months = label(ctx)
    this.view.add(this.activityTitle)
    for (let index = 0; index < 5; index++) {
      const summary = label(ctx)
      this.summaries.push(summary)
      this.view.add(summary)
    }
    this.view.add(this.months)

    for (let index = 0; index < DAY_COUNT; index++) {
      const chartRow = label(ctx)
      this.chart.push(chartRow)
      this.view.add(chartRow)
    }

    this.caption = label(ctx)
    this.views = label(ctx)
    this.hint = label(ctx, { color: COLORS.faint })
    this.view.add(this.caption)
    this.view.add(this.views)
    this.view.add(this.hint)
  }

  show(summary: ProviderUsageSummary, view: UsageActivityView, provider?: string): void {
    this.summary = summary
    this.activityView = view
    this.metric = "total"
    this.providerName = provider
    this.render()
    this.view.visible = true
    this.onChange()
  }

  fit(): void {
    if (!this.view.visible) return
    this.render()
  }

  hide(): void {
    if (!this.view.visible) return
    this.view.visible = false
    this.onChange()
  }

  handleKey(name: string): boolean {
    if (!this.view.visible) return false
    if (name === "escape") {
      this.hide()
      return true
    }
    if (name === "left" || name === "right") {
      this.activityView = nextUsageActivityView(this.activityView, name === "left" ? -1 : 1)
      this.render()
      this.onChange()
      return true
    }
    if (name === "d" || name === "w" || name === "c") {
      this.activityView = name === "d" ? "daily" : name === "w" ? "weekly" : "cumulative"
      this.render()
      this.onChange()
      return true
    }
    if (name === "m") {
      this.metric = this.metric === "total" ? "uncached" : "total"
      this.render()
      this.onChange()
    }
    return true
  }

  private render(): void {
    if (!this.summary) return
    const now = this.now()
    const width = this.availableWidth()
    const activity = buildUsageActivity(this.summary, this.metric, now)
    const window = chartWindow(activity, now, width)
    this.title.content = `/usage ${this.activityView}`
    this.provider.content = new StyledText([muted(this.providerName ?? "All providers")])
    this.activityTitle.content = new StyledText([
      paint(COLORS.foreground, ` ${metricLabel(this.metric)}`),
      muted(window.shownColumns === WEEK_COUNT ? " · 52 weeks" : ` · recent ${window.shownColumns} weeks`),
    ])
    const summaries = summaryRows(activity, width)
    this.summaryRowCount = summaries.length
    this.view.height = this.summaryRowCount + 15
    this.summaries.forEach((summary, index) => {
      summary.visible = index < summaries.length
      if (summaries[index]) summary.content = summaries[index]
    })
    this.months.content = new StyledText([muted(monthLabels(window))])
    const rows = chartRows(window, this.activityView, now)
    this.chart.forEach((row, index) => {
      row.content = rows[index]!
    })
    this.caption.content = chartCaption(window, this.activityView)
    this.views.content = viewsFooter(this.activityView)
    const hint = "    ←→ view · M metric · Esc close"
    this.hint.content =
      width < 64 ? hint : `${hint} · ${this.metric === "uncached" ? "cache reads excluded" : "cache reads included"}`
  }
}
