import {
  CliRenderEvents,
  InputRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextBuffer,
  TextBufferView,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import type { ElicitationAnswer, ElicitationQuestion } from "../../../tools/types"
import { ImeCommitBarrier, imeKeyDown } from "../lib/ime"
import { column, label, paragraph, row } from "../lib/renderables"
import { terminalGlyph } from "../lib/text"
import { COLORS } from "../theme/colors"
import { background, border, inputColors, muted, paint } from "../theme/styles"

const MAX_COMPLETION_DOTS = 8

function wrappedRows(ctx: RenderContext, value: string, width: number): number {
  const buffer = TextBuffer.create(ctx.widthMethod)
  try {
    buffer.setText(value)
    const view = TextBufferView.create(buffer)
    try {
      view.setWrapMode("word")
      view.setWrapWidth(Math.max(1, width))
      return Math.max(1, view.getVirtualLineCount())
    } finally {
      view.destroy()
    }
  } finally {
    buffer.destroy()
  }
}

interface ChoiceRow {
  view: BoxRenderable
  header: BoxRenderable
  marker: TextRenderable
  name: TextRenderable
  description: TextRenderable
}

interface ChoiceMetrics {
  promptRows: number
  nameRows: number[]
  descriptionRows: number[]
  viewportRows: number
  scrollable: boolean
}

interface ReviewRow {
  view: BoxRenderable
  marker: TextRenderable
  name: TextRenderable
  answer: TextRenderable
}

interface ReviewMetrics {
  markerWidth: number
  nameRows: number[]
  answerRows: number[]
  contentRows: number
  viewportRows: number
  scrollable: boolean
}

export interface ElicitationPopoverActions {
  answer(requestId: string, answers: ElicitationAnswer[]): void
  reject(requestId: string): void
}

export class ElicitationPopover {
  readonly view: BoxRenderable
  private readonly title: TextRenderable
  private readonly completion: TextRenderable
  private readonly questionBody: ScrollBoxRenderable
  private readonly prompt: TextRenderable
  private readonly choices: BoxRenderable
  private readonly choiceRows: ChoiceRow[] = []
  private readonly inputRow: BoxRenderable
  private readonly input: InputRenderable
  private readonly imeCommit = new ImeCommitBarrier()
  private readonly review: ScrollBoxRenderable
  private readonly reviewRows: ReviewRow[] = []
  private readonly submitRow: TextRenderable
  private readonly hint: TextRenderable
  private requestId: string | undefined
  private questions: ElicitationQuestion[] = []
  private answers: Array<string | undefined> = []
  private questionIndex = 0
  private selected = 0
  private enteringText = false
  private reviewing = false
  private returnToReview = false
  private choiceLayout: ChoiceMetrics | undefined
  private reviewLayout: ReviewMetrics | undefined
  private scrollRequest = 0
  private measuredAvailableHeight = 0

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    if (!this.reviewing) return (this.choiceLayout ?? this.choiceMetrics()).viewportRows + 6
    const promptRows = this.promptRows()
    return promptRows + (this.reviewLayout ?? this.reviewMetrics(promptRows)).viewportRows + 6
  }

  fit(): void {
    if (!this.visible || this.availableHeight() === this.measuredAvailableHeight) return
    this.render()
  }

  constructor(
    private readonly ctx: RenderContext,
    private readonly actions: ElicitationPopoverActions,
    private readonly onChange: () => void,
    private readonly availableHeight: () => number,
  ) {
    this.view = column(ctx, {
      visible: false,
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
    header.add(label(ctx, { content: "?", width: 2, attributes: TextAttributes.BOLD, color: COLORS.agent }))
    this.title = label(ctx, {
      content: "",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      attributes: TextAttributes.BOLD,
    })
    header.add(this.title)
    this.completion = label(ctx, { content: "", flexShrink: 0, marginLeft: 1 })
    header.add(this.completion)
    this.view.add(header)

    this.questionBody = new ScrollBoxRenderable(ctx, {
      height: 1,
      flexShrink: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      horizontalScrollbarOptions: { height: 0 },
      verticalScrollbarOptions: {
        showArrows: false,
        trackOptions: { backgroundColor: COLORS.background, foregroundColor: COLORS.border },
      },
    })
    this.prompt = paragraph(ctx, { content: "", height: 1, marginLeft: 2, marginRight: 2 })
    this.questionBody.add(this.prompt)
    this.choices = column(ctx, { marginTop: 1 })
    this.questionBody.add(this.choices)
    this.view.add(this.questionBody)

    this.inputRow = column(ctx, { visible: false, height: 2, marginLeft: 2, marginRight: 2, marginTop: 1 })
    this.inputRow.add(label(ctx, { content: "Other answer", color: COLORS.accent, attributes: TextAttributes.BOLD }))
    const inputLine = row(ctx, { height: 1 })
    inputLine.add(label(ctx, { content: terminalGlyph("❯", ">"), width: 3, color: COLORS.accent }))
    this.input = new InputRenderable(ctx, {
      placeholder: "Type your answer",
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 1,
      scrollMargin: 0,
      onKeyDown: (key) => {
        imeKeyDown(key, {
          barrier: this.imeCommit,
          insert: (text) => {
            if (!this.input.isDestroyed) this.input.insertText(text)
          },
          fallback: (event) => {
            if (!this.input.isDestroyed) this.input.handleKeyPress(event)
          },
        })
      },
      ...inputColors(),
    })
    inputLine.add(this.input)
    this.inputRow.add(inputLine)
    this.questionBody.add(this.inputRow)

    this.review = new ScrollBoxRenderable(ctx, {
      visible: false,
      height: 1,
      flexShrink: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      horizontalScrollbarOptions: { height: 0 },
      verticalScrollbarOptions: {
        showArrows: false,
        trackOptions: { backgroundColor: COLORS.background, foregroundColor: COLORS.border },
      },
    })
    this.submitRow = label(ctx, { content: "", height: 1, marginLeft: 2 })
    this.review.add(this.submitRow)
    this.view.add(this.review)

    this.hint = label(ctx, { content: "", marginLeft: 2, marginTop: 1, color: COLORS.faint })
    this.view.add(this.hint)

    ctx.on("resize", () => {
      if (!this.visible) return
      this.render()
      this.onChange()
    })
  }

  private ensureChoiceRows(count: number): void {
    while (this.choiceRows.length > count) {
      const choice = this.choiceRows.pop()
      if (!choice) break
      this.choices.remove(choice.view)
      choice.view.destroyRecursively()
    }
    while (this.choiceRows.length < count) {
      const choice = column(this.ctx, { height: 1, marginRight: 2 })
      const choiceHeader = row(this.ctx, { height: 1 })
      const marker = label(this.ctx, { content: "", width: 4, flexShrink: 0, attributes: TextAttributes.BOLD })
      const name = paragraph(this.ctx, {
        content: "",
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 1,
        attributes: TextAttributes.BOLD,
      })
      choiceHeader.add(marker)
      choiceHeader.add(name)
      choice.add(choiceHeader)
      const description = paragraph(this.ctx, { content: "", height: 1, marginLeft: 4, color: COLORS.faint })
      choice.add(description)
      this.choiceRows.push({ view: choice, header: choiceHeader, marker, name, description })
      this.choices.add(choice)
    }
  }

  private ensureReviewRows(count: number): void {
    while (this.reviewRows.length > count) {
      const review = this.reviewRows.pop()
      if (!review) break
      this.review.remove(review.view)
      review.view.destroyRecursively()
    }
    while (this.reviewRows.length < count) {
      const reviewRow = row(this.ctx, { height: 2, marginLeft: 2, marginRight: 2 })
      const marker = label(this.ctx, { content: "", width: 5 })
      const copy = column(this.ctx, { flexGrow: 1, flexShrink: 1, minWidth: 1 })
      const name = paragraph(this.ctx, { content: "", height: 1, attributes: TextAttributes.BOLD })
      const answer = paragraph(this.ctx, { content: "", height: 1, color: COLORS.faint })
      copy.add(name)
      copy.add(answer)
      reviewRow.add(marker)
      reviewRow.add(copy)
      this.review.add(reviewRow, this.reviewRows.length)
      this.reviewRows.push({ view: reviewRow, marker, name, answer })
    }
  }

  show(requestId: string, questions: ElicitationQuestion[]): void {
    this.close()
    this.requestId = requestId
    this.questions = questions
    this.answers = Array.from({ length: questions.length })
    this.questionIndex = 0
    this.selected = 0
    this.enteringText = false
    this.reviewing = false
    this.returnToReview = false
    this.view.visible = true
    this.render()
    this.onChange()
  }

  hide(): void {
    this.close()
  }

  focus(): void {
    if (this.enteringText && this.visible) this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }

  handleKey(name: string): boolean {
    if (!this.visible) return false
    if (this.reviewing) return this.handleReviewKey(name)
    if (name === "pageup" || name === "pagedown") {
      this.questionBody.scrollBy(name === "pageup" ? -1 : 1, "viewport")
      return true
    }
    if (this.enteringText) return this.handleTextKey(name)
    if (name === "left") {
      this.openQuestion(this.questionIndex - 1)
      return true
    }
    if (name === "right") {
      this.openNext()
      return true
    }
    if (name === "up" || name === "down") {
      this.move(name === "up" ? -1 : 1)
      return true
    }
    if (name === "escape") {
      if (this.returnToReview) {
        this.openReview()
        return true
      }
      this.reject()
      return true
    }
    const shortcut = Number(name)
    const count = (this.questions[this.questionIndex]?.options.length ?? 0) + 1
    if (Number.isInteger(shortcut) && shortcut >= 1 && shortcut <= count) {
      this.selected = shortcut - 1
      this.confirm()
      return true
    }
    if (name === "return" || name === "enter") this.confirm()
    return true
  }

  private handleReviewKey(name: string): boolean {
    if (name === "up" || name === "down") {
      this.review.scrollBy(name === "up" ? -1 : 1, "step")
      return true
    }
    if (name === "return" || name === "enter") {
      this.submit()
      return true
    }
    if (name === "left" || name === "escape") {
      this.returnToReview = true
      this.openQuestion(this.questions.length - 1)
      return true
    }
    const shortcut = Number(name)
    if (Number.isInteger(shortcut) && shortcut >= 1 && shortcut <= this.questions.length) {
      this.returnToReview = true
      this.openQuestion(shortcut - 1)
    }
    return true
  }

  private handleTextKey(name: string): boolean {
    if (name === "escape") {
      if (this.imeCommit.pending) {
        this.imeCommit.enqueue(() => {
          this.handleTextKey(name)
        })
        return true
      }
      this.enteringText = false
      this.input.value = ""
      this.input.blur()
      this.selected = this.selectionFor(this.questionIndex)
      this.render()
      this.onChange()
      return true
    }
    if (name === "return" || name === "enter") {
      if (this.imeCommit.pending) {
        this.imeCommit.enqueue(() => {
          this.handleTextKey(name)
        })
        return true
      }
      const value = this.input.value.trim()
      if (value) this.save(value)
      return true
    }
    return false
  }

  private move(delta: number): void {
    const count = (this.questions[this.questionIndex]?.options.length ?? 0) + 1
    this.selected = (this.selected + delta + count) % count
    this.renderOptions(this.choiceLayout ?? this.choiceMetrics())
  }

  private confirm(): void {
    const question = this.questions[this.questionIndex]
    if (!question) return
    const option = question.options[this.selected]
    if (option) {
      this.save(option.label)
      return
    }
    this.enteringText = true
    this.input.value = this.customAnswer(this.questionIndex) ?? ""
    this.render()
    this.input.focus()
    this.onChange()
  }

  private save(value: string): void {
    this.answers[this.questionIndex] = value
    if (this.returnToReview) {
      this.openReview()
      return
    }
    this.openNext()
  }

  private openNext(): void {
    if (this.questionIndex + 1 < this.questions.length) {
      this.openQuestion(this.questionIndex + 1)
      return
    }
    if (!this.answers.every((answer) => answer)) return
    if (this.questions.length === 1) {
      this.submit()
      return
    }
    this.openReview()
  }

  private openQuestion(index: number): void {
    if (index < 0 || index >= this.questions.length) return
    this.questionIndex = index
    this.selected = this.selectionFor(index)
    this.enteringText = false
    this.reviewing = false
    this.input.value = ""
    this.input.blur()
    this.questionBody.scrollTop = 0
    this.render()
    this.onChange()
  }

  private openReview(): void {
    this.enteringText = false
    this.reviewing = true
    this.returnToReview = false
    this.input.value = ""
    this.input.blur()
    this.render()
    this.review.scrollTop = 0
    this.onChange()
  }

  private selectionFor(index: number): number {
    const question = this.questions[index]
    const answer = this.answers[index]
    if (!question || !answer) return 0
    const selected = question.options.findIndex((option) => option.label === answer)
    return selected < 0 ? question.options.length : selected
  }

  private customAnswer(index: number): string | undefined {
    const question = this.questions[index]
    const answer = this.answers[index]
    if (!question || !answer || question.options.some((option) => option.label === answer)) return undefined
    return answer
  }

  private currentOptions(): Array<{ label: string; description: string }> {
    const question = this.questions[this.questionIndex]
    if (!question) return []
    return [
      ...question.options,
      {
        label: "Other",
        description: this.customAnswer(this.questionIndex) ?? "Type a different answer in your own words.",
      },
    ]
  }

  private promptRows(scrollable = false): number {
    const value = this.reviewing
      ? "Review each answer, then submit."
      : (this.questions[this.questionIndex]?.question ?? "")
    return wrappedRows(this.ctx, value, this.ctx.width - (scrollable ? 11 : 10))
  }

  private choiceNameRows(value: string, scrollable: boolean): number {
    return wrappedRows(this.ctx, value, this.ctx.width - (scrollable ? 13 : 12))
  }

  private choiceDescriptionRows(value: string): number {
    return wrappedRows(this.ctx, value, this.ctx.width - 12)
  }

  private choiceMetrics(): ChoiceMetrics {
    const options = this.currentOptions()
    const availableHeight = this.availableHeight()
    this.measuredAvailableHeight = availableHeight
    const availableRows = Math.max(1, availableHeight - 6)
    const calculate = (scrollable: boolean): ChoiceMetrics => {
      const promptRows = this.promptRows(scrollable)
      if (this.enteringText) {
        const contentRows = promptRows + 3
        return { promptRows, nameRows: [], descriptionRows: [], viewportRows: contentRows, scrollable }
      }
      const nameRows = options.map((option) => this.choiceNameRows(option.label, scrollable))
      const descriptionRows = options.map((option) => this.choiceDescriptionRows(option.description))
      const contentRows = options.reduce(
        (rows, _, index) => rows + (nameRows[index] ?? 1) + (descriptionRows[index] ?? 1),
        promptRows + 1,
      )
      return { promptRows, nameRows, descriptionRows, viewportRows: contentRows, scrollable }
    }
    let metrics = calculate(false)
    if (metrics.viewportRows > availableRows) metrics = calculate(true)
    return {
      ...metrics,
      viewportRows: Math.min(metrics.viewportRows, availableRows),
      scrollable: metrics.viewportRows > availableRows,
    }
  }

  private reviewMetrics(promptRows = this.promptRows()): ReviewMetrics {
    const availableHeight = this.availableHeight()
    this.measuredAvailableHeight = availableHeight
    const availableRows = Math.max(1, Math.min(8, availableHeight - promptRows - 6))
    const markerWidth = Math.max(5, String(this.questions.length).length + 2)
    const calculate = (scrollable: boolean): ReviewMetrics => {
      const width = this.ctx.width - markerWidth - (scrollable ? 11 : 10)
      const nameRows = this.questions.map((question) => wrappedRows(this.ctx, question.header, width))
      const answerRows = this.answers.map((answer) => wrappedRows(this.ctx, answer ?? "", width))
      const contentRows = this.questions.reduce(
        (rows, _, index) => rows + (nameRows[index] ?? 1) + (answerRows[index] ?? 1),
        1,
      )
      return { markerWidth, nameRows, answerRows, contentRows, viewportRows: contentRows, scrollable }
    }
    let metrics = calculate(false)
    if (metrics.contentRows > availableRows) metrics = calculate(true)
    return {
      ...metrics,
      viewportRows: Math.min(metrics.contentRows, availableRows),
      scrollable: metrics.contentRows > availableRows,
    }
  }

  private submit(): void {
    const requestId = this.requestId
    const answers = this.questions.flatMap((question, index): ElicitationAnswer[] => {
      const value = this.answers[index]
      return value ? [{ questionId: question.id, value }] : []
    })
    if (!requestId || answers.length !== this.questions.length) return
    this.close()
    this.actions.answer(requestId, answers)
  }

  private reject(): void {
    const requestId = this.requestId
    this.close()
    if (requestId) this.actions.reject(requestId)
  }

  private close(): void {
    const changed = this.view.visible
    this.imeCommit.clear()
    this.view.visible = false
    this.input.blur()
    this.input.value = ""
    this.ensureChoiceRows(0)
    this.ensureReviewRows(0)
    this.questionBody.scrollTop = 0
    this.review.scrollTop = 0
    this.choiceLayout = undefined
    this.reviewLayout = undefined
    this.scrollRequest++
    this.measuredAvailableHeight = 0
    this.requestId = undefined
    this.questions = []
    this.answers = []
    this.questionIndex = 0
    this.selected = 0
    this.enteringText = false
    this.reviewing = false
    this.returnToReview = false
    if (changed) this.onChange()
  }

  private render(): void {
    if (this.reviewing) {
      this.renderReview()
      return
    }
    const question = this.questions[this.questionIndex]
    if (!question) return
    this.renderCompletion()
    this.title.content = new StyledText([
      paint(COLORS.agent, question.header),
      muted(` · Question ${this.questionIndex + 1} of ${this.questions.length}`),
    ])
    this.prompt.content = question.question
    const choiceMetrics = this.choiceMetrics()
    this.choiceLayout = choiceMetrics
    this.reviewLayout = undefined
    this.prompt.height = choiceMetrics.promptRows
    this.questionBody.visible = true
    this.questionBody.height = choiceMetrics.viewportRows
    this.choices.visible = !this.enteringText
    this.inputRow.visible = this.enteringText
    this.review.visible = false
    this.renderOptions(choiceMetrics)
    const shortcutCount = Math.min(question.options.length + 1, 9)
    const shortcut = shortcutCount === 1 ? "1" : `1-${shortcutCount}`
    const select = `${shortcut} select`
    const choose = choiceMetrics.scrollable ? "↑↓ choose · PgUp/PgDn scroll" : "↑↓ choose"
    const questions = `${terminalGlyph("←", "<")}${terminalGlyph("→", ">")} questions`
    this.hint.content = this.enteringText
      ? `${choiceMetrics.scrollable ? "PgUp/PgDn scroll · " : ""}Enter save · Esc choices`
      : this.ctx.width < 100
        ? `${questions} · ↑↓${choiceMetrics.scrollable ? " · Pg↑↓" : ""} · ${shortcut} · Enter · Esc`
        : `${questions} · ${choose} · ${select} · Enter save · Esc decline`
    this.view.height = choiceMetrics.viewportRows + 5
  }

  private renderCompletion(): void {
    if (this.questions.length > MAX_COMPLETION_DOTS) {
      this.completion.content = new StyledText([
        paint(COLORS.accent, `${this.questionIndex + 1}/${this.questions.length}`),
      ])
      return
    }
    this.completion.content = new StyledText(
      this.questions.flatMap((_, index) => {
        const active = index === this.questionIndex
        const answered = this.answers[index] !== undefined
        const dot = terminalGlyph(active || answered ? "●" : "○", active || answered ? "*" : "o")
        const chunk = active ? paint(COLORS.accent, dot) : answered ? paint(COLORS.success, dot) : muted(dot)
        return index === this.questions.length - 1 ? [chunk] : [chunk, muted(" ")]
      }),
    )
  }

  private renderOptions(metrics: ChoiceMetrics): void {
    const question = this.questions[this.questionIndex]
    const custom = this.customAnswer(this.questionIndex)
    const options = this.currentOptions()
    const answer = this.answers[this.questionIndex]
    this.ensureChoiceRows(options.length)
    this.choiceRows.forEach((entry, index) => {
      const option = options[index]
      if (!option) {
        entry.view.visible = false
        entry.marker.content = ""
        entry.name.content = ""
        entry.description.content = ""
        return
      }
      const selected = index === this.selected
      const nameRows = metrics.nameRows[index] ?? 1
      const descriptionRows = metrics.descriptionRows[index] ?? 1
      entry.view.visible = true
      entry.view.height = nameRows + descriptionRows
      entry.header.height = nameRows
      entry.name.height = nameRows
      entry.description.visible = true
      entry.description.height = descriptionRows
      entry.description.content = new StyledText([muted(option.description)])
      const chosen = index === question?.options.length ? custom !== undefined : option.label === answer
      const cursor = selected ? terminalGlyph("❯", ">") : " "
      const marker = chosen ? terminalGlyph("●", "x") : terminalGlyph("○", "o")
      entry.marker.content = new StyledText([
        selected
          ? paint(COLORS.accent, `${cursor} ${marker}`)
          : chosen
            ? paint(COLORS.success, `${cursor} ${marker}`)
            : muted(`${cursor} ${marker}`),
      ])
      entry.name.content = new StyledText([
        selected ? paint(COLORS.accent, option.label) : paint(COLORS.foreground, option.label),
      ])
    })
    if (!this.enteringText) this.scrollSelectionIntoView(metrics)
    this.scheduleQuestionScroll(metrics)
  }

  private scheduleQuestionScroll(metrics: ChoiceMetrics): void {
    const request = ++this.scrollRequest
    const questionIndex = this.questionIndex
    const enteringText = this.enteringText
    this.ctx.once(CliRenderEvents.FRAME, () => {
      if (
        request !== this.scrollRequest ||
        !this.visible ||
        this.reviewing ||
        questionIndex !== this.questionIndex ||
        enteringText !== this.enteringText
      ) {
        return
      }
      if (enteringText) this.questionBody.scrollTop = metrics.promptRows
      else this.scrollSelectionIntoView(metrics)
      this.ctx.requestRender()
    })
  }

  private scrollSelectionIntoView(metrics: ChoiceMetrics): void {
    const selectedTop = metrics.nameRows
      .slice(0, this.selected)
      .reduce((rows, name, index) => rows + name + (metrics.descriptionRows[index] ?? 1), metrics.promptRows + 1)
    const selectedRows = (metrics.nameRows[this.selected] ?? 1) + (metrics.descriptionRows[this.selected] ?? 1)
    if (this.selected === 0 && this.questionBody.scrollTop === 0) return
    if (selectedTop < this.questionBody.scrollTop || selectedRows >= metrics.viewportRows) {
      this.questionBody.scrollTop = selectedTop
      return
    }
    const selectedBottom = selectedTop + selectedRows
    if (selectedBottom > this.questionBody.scrollTop + metrics.viewportRows) {
      this.questionBody.scrollTop = selectedBottom - metrics.viewportRows
    }
  }

  private renderReview(): void {
    const promptRows = this.promptRows()
    const metrics = this.reviewMetrics(promptRows)
    this.reviewLayout = metrics
    this.ensureReviewRows(this.questions.length)
    this.completion.content = new StyledText(
      this.questions.length > MAX_COMPLETION_DOTS
        ? [paint(COLORS.success, `${this.questions.length}/${this.questions.length}`)]
        : this.questions.flatMap((_, index) => {
            const dot = paint(COLORS.success, terminalGlyph("●", "*"))
            return index === this.questions.length - 1 ? [dot] : [dot, muted(" ")]
          }),
    )
    this.title.content = new StyledText([paint(COLORS.agent, "Review answers")])
    this.prompt.content = "Review each answer, then submit."
    this.prompt.height = promptRows
    this.questionBody.visible = true
    this.questionBody.height = promptRows
    this.choiceLayout = undefined
    this.choices.visible = false
    this.inputRow.visible = false
    this.review.visible = true
    this.reviewRows.forEach((entry, index) => {
      const question = this.questions[index]
      if (!question) {
        entry.view.visible = false
        entry.marker.content = ""
        entry.name.content = ""
        entry.answer.content = ""
        return
      }
      const nameRows = metrics.nameRows[index] ?? 1
      const answerRows = metrics.answerRows[index] ?? 1
      entry.view.visible = true
      entry.view.height = nameRows + answerRows
      entry.marker.width = metrics.markerWidth
      entry.name.height = nameRows
      entry.answer.height = answerRows
      entry.marker.content = new StyledText([muted(`[${index + 1}]`)])
      entry.name.content = new StyledText([paint(COLORS.foreground, question.header)])
      entry.answer.content = new StyledText([muted(this.answers[index] ?? "")])
    })
    this.review.height = metrics.viewportRows
    this.submitRow.content = new StyledText([paint(COLORS.accent, `${terminalGlyph("❯", ">")} Submit answers`)])
    const shortcutCount = Math.min(this.questions.length, 9)
    const edit = shortcutCount === 1 ? "1 edit" : `1-${shortcutCount} edit`
    const scroll = metrics.scrollable ? "↑↓ scroll · " : ""
    this.hint.content = `${scroll}${edit} · Enter submit · Esc back`
    this.view.height = promptRows + metrics.viewportRows + 5
  }
}
