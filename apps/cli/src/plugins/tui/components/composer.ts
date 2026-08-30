import {
  BoxRenderable,
  decodePasteBytes,
  RenderableEvents,
  stripAnsiSequences,
  SyntaxStyle,
  TextareaRenderable,
  TextAttributes,
  type PasteEvent,
  type RenderContext,
  type RGBA,
  type TextRenderable,
} from "@opentui/core"
import { describeError } from "../../../lib/error"
import { asNumber, asString, isRecord } from "../../../lib/json"
import type { ImageInput, UserInput } from "../../../providers/types"
import { findSkillReferences, type SkillQuery } from "../../../skills/references"
import { fileMention, type FileQuery } from "../file-search"
import { FOOTER_ICON_WIDTH } from "../lib/footer-grid"
import { ImeCommitBarrier, imeKeyDown } from "../lib/ime"
import { label, row } from "../lib/renderables"
import type { MessageHistory } from "../message-history"
import { COLORS, resolveColor } from "../theme/colors"
import { border, inputColors } from "../theme/styles"

export const COMPOSER_ROWS = 4

interface ComposerActions {
  submit(input: UserInput): boolean
  run(line: string): void
  error(message: string): void
  change(value: string, cursor: number): void
  resize(): void
}

interface PastedContent {
  kind: "pasted-content"
  text: string
}

interface PastedImage {
  kind: "pasted-image"
  number: number
  image: ImageInput
}

function sameInput(left: UserInput, right: UserInput): boolean {
  if (left.text !== right.text || left.images.length !== right.images.length) return false
  return left.images.every((image, index) => {
    const other = right.images[index]
    return other !== undefined && image.mediaType === other.mediaType && image.data === other.data
  })
}

function isPastedContent(value: unknown): value is PastedContent {
  return isRecord(value) && value.kind === "pasted-content" && asString(value.text) !== undefined
}

function isPastedImage(value: unknown): value is PastedImage {
  if (!isRecord(value) || value.kind !== "pasted-image" || asNumber(value.number) === undefined) return false
  const image = value.image
  return (
    isRecord(image) &&
    (image.mediaType === "image/png" || image.mediaType === "image/jpeg") &&
    asString(image.data) !== undefined
  )
}

function editorOffset(input: TextareaRenderable, index: number): number {
  const target = Math.max(0, Math.min(index, input.plainText.length))
  let low = 0
  let high = Math.max(1, input.plainText.length)
  while (input.getTextRange(0, high).length < target) high *= 2
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (input.getTextRange(0, middle).length < target) low = middle + 1
    else high = middle
  }
  return low
}

async function linuxClipboardImage(): Promise<Bun.Image | undefined> {
  for (const command of [
    ["wl-paste", "--no-newline", "--type", "image/png"],
    ["wl-paste", "--no-newline", "--type", "image/jpeg"],
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ["xclip", "-selection", "clipboard", "-t", "image/jpeg", "-o"],
  ]) {
    try {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const bytes = await new Response(child.stdout).bytes()
      if ((await child.exited) === 0 && bytes.length > 0) return new Bun.Image(bytes)
    } catch {}
  }
}

export class Composer {
  readonly view: BoxRenderable
  private readonly input: TextareaRenderable
  private readonly prompt: TextRenderable
  private readonly badge: TextRenderable
  private readonly pastedContentType: number
  private readonly pastedImageType: number
  private readonly skillHighlightType: number
  private readonly fileHighlightType: number
  private readonly syntaxStyle: SyntaxStyle
  private readonly imageStyleId: number
  private readonly skillStyleId: number
  private readonly fileStyleId: number
  private readonly imeCommit = new ImeCommitBarrier()
  private currentRows = COMPOSER_ROWS
  private readingImage = false

  constructor(
    private readonly ctx: RenderContext,
    private readonly history: MessageHistory,
    private readonly actions: ComposerActions,
    private readonly indicator: RGBA | undefined = undefined,
  ) {
    this.view = row(ctx, {
      height: 3,
      alignItems: "flex-start",
      border: ["top", "bottom"],
      paddingLeft: 0,
      paddingRight: 0,
      marginLeft: 2,
      marginRight: 2,
      marginTop: 1,
      ...border(COLORS.border),
    })
    if (indicator !== undefined) {
      const borderColor = resolveColor(indicator)
      this.view.borderColor = borderColor
      this.view.focusedBorderColor = borderColor
    }

    this.prompt = label(ctx, {
      content: "❯",
      width: FOOTER_ICON_WIDTH,
      attributes: TextAttributes.BOLD,
      color: indicator ?? COLORS.accent,
    })
    this.view.add(this.prompt)
    this.syntaxStyle = SyntaxStyle.create()
    this.imageStyleId = this.syntaxStyle.registerStyle("composer-image", { fg: resolveColor(COLORS.accent) })
    this.skillStyleId = this.syntaxStyle.registerStyle("composer-skill", {
      fg: resolveColor(COLORS.accent),
      bold: true,
    })
    this.fileStyleId = this.syntaxStyle.registerStyle("composer-file", { fg: resolveColor(COLORS.accent) })
    this.input = new TextareaRenderable(ctx, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 1,
      wrapMode: "word",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
      ],
      onContentChange: () => this.change(),
      onCursorChange: () => this.notifyCompletion(),
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
      onSubmit: () =>
        this.imeCommit.enqueue(() => {
          if (!this.input.isDestroyed) this.submit()
        }),
      onPaste: (event) => this.paste(event),
      syntaxStyle: this.syntaxStyle,
      ...inputColors(),
    })
    this.pastedContentType = this.input.extmarks.registerType("composer-pasted-content")
    this.pastedImageType = this.input.extmarks.registerType("composer-pasted-image")
    this.skillHighlightType = this.input.extmarks.registerType("composer-skill-highlight")
    this.fileHighlightType = this.input.extmarks.registerType("composer-file-highlight")
    this.view.add(this.input)
    this.badge = label(ctx, {
      content: "",
      color: indicator ?? COLORS.accent,
      flexShrink: 0,
    })
    this.view.add(this.badge)
    this.view.on(RenderableEvents.DESTROYED, () => {
      this.imeCommit.clear()
      this.syntaxStyle.destroy()
    })
  }

  setBadge(text: string | undefined): void {
    this.badge.content = text ?? ""
  }

  get rows(): number {
    return this.currentRows
  }

  get empty(): boolean {
    return !this.input.plainText
  }

  setValue(text: string): void {
    this.history.reset()
    if (this.afterIme(() => this.replaceInput({ text, images: [] }))) return
    this.replaceInput({ text, images: [] })
  }

  draft(): UserInput {
    return this.value()
  }

  replaceDraft(input: UserInput, expected: UserInput): void {
    if (!sameInput(this.value(), expected)) {
      throw new Error("composer changed while the external editor was open — edited text was not applied")
    }
    this.history.reset()
    this.replaceInput(input)
  }

  completeSkill(query: SkillQuery, name: string, trailingSpace: boolean): void {
    if (this.afterIme(() => this.completeSkill(query, name, trailingSpace))) return
    const text = this.input.plainText
    if (!text.slice(query.start, query.end).startsWith("$")) return
    const next = text.slice(query.end).match(/^./u)?.[0]
    const suffix = trailingSpace && (next === undefined || !/\s/.test(next)) ? " " : ""
    this.input.setSelection(editorOffset(this.input, query.start), editorOffset(this.input, query.end))
    this.input.deleteSelection()
    this.input.insertText(`$${name}${suffix}`)
  }

  completeFile(query: FileQuery, path: string): void {
    if (this.afterIme(() => this.completeFile(query, path))) return
    const text = this.input.plainText
    if (!text.slice(query.start, query.end).startsWith("@")) return
    const mention = fileMention(path, query.quoted)
    const next = text.slice(query.end).match(/^./u)?.[0]
    const suffix = next === undefined || !/\s/.test(next) ? " " : ""
    const start = editorOffset(this.input, query.start)
    this.input.setSelection(start, editorOffset(this.input, query.end))
    this.input.deleteSelection()
    this.input.insertText(`${mention}${suffix}`)
    this.input.extmarks.create({
      start,
      end: editorOffset(this.input, query.start + mention.length),
      virtual: true,
      styleId: this.fileStyleId,
      typeId: this.fileHighlightType,
    })
  }

  refreshCompletion(): void {
    this.notifyCompletion()
  }

  clear(): boolean {
    if (!this.input.plainText && !this.imeCommit.pending) return false
    this.setValue("")
    return true
  }

  restore(inputs: UserInput[]): void {
    if (inputs.length === 0) return
    this.history.reset()
    const hadDraft = this.input.plainText.length > 0
    this.input.gotoBufferHome()
    inputs.forEach((input, index) => {
      if (index > 0) this.input.insertText("\n")
      if (input.text) this.input.insertText(input.text)
      input.images.forEach((image, imageIndex) => {
        if (input.text || imageIndex > 0) this.input.insertText(" ")
        this.attachImage(image)
      })
    })
    if (hadDraft) this.input.insertText("\n")
    this.input.gotoBufferEnd()
    this.reflow()
  }

  newLine(): void {
    this.imeCommit.enqueue(() => {
      if (!this.input.isDestroyed) this.input.newLine()
    })
  }

  navigateHistory(direction: "older" | "newer"): boolean {
    if (this.imeCommit.pending) {
      this.imeCommit.enqueue(() => this.navigateHistory(direction))
      return true
    }
    const cursor = this.input.visualCursor
    const row = this.input.editorView.getViewport().offsetY + cursor.visualRow
    const boundary = direction === "older" ? row === 0 : row === this.input.editorView.getTotalVirtualLineCount() - 1
    if (!boundary) return false
    const recalled = direction === "older" ? this.history.older(this.value()) : this.history.newer()
    if (!recalled) return false
    this.replaceInput(recalled)
    return true
  }

  async pasteImage(): Promise<boolean> {
    if (this.readingImage) return false
    this.readingImage = true
    try {
      const clipboard = process.platform === "linux" ? await linuxClipboardImage() : Bun.Image.fromClipboard()
      if (!clipboard) return false
      this.attachImage({ mediaType: "image/png", data: await clipboard.png().toBase64() })
      return true
    } catch {
      return false
    } finally {
      this.readingImage = false
    }
  }

  private attachImage(image: ImageInput): void {
    const numbers = this.input.extmarks
      .getAllForTypeId(this.pastedImageType)
      .flatMap((mark) => (isPastedImage(mark.data) ? [mark.data.number] : []))
    const number = Math.max(0, ...numbers) + 1
    const text = `[Image #${number}]`
    this.input.insertText(text)
    const end = this.input.cursorOffset
    this.input.extmarks.create({
      start: end - text.length,
      end,
      virtual: true,
      styleId: this.imageStyleId,
      typeId: this.pastedImageType,
      data: { kind: "pasted-image", number, image } satisfies PastedImage,
    })
    this.change()
  }

  reflow(): void {
    const totalRows = this.input.plainText ? this.input.editorView.getTotalVirtualLineCount() : 1
    const terminalRows = this.ctx.terminalHeight ?? this.ctx.height
    const inputRows = Math.min(totalRows, Math.max(1, terminalRows - 5))
    const rows = inputRows + 3
    if (rows === this.currentRows) return
    this.input.height = inputRows
    this.view.height = inputRows + 2
    this.currentRows = rows
    this.actions.resize()
  }

  setVisible(visible: boolean): void {
    this.view.visible = visible
  }

  focus(): void {
    this.input.focus()
  }

  blur(): void {
    this.input.blur()
  }

  private change(): void {
    if (this.indicator !== undefined) {
      const borderColor = resolveColor(this.indicator)
      this.prompt.fg = borderColor
      this.view.borderColor = borderColor
      this.view.focusedBorderColor = borderColor
      this.syncSkillHighlights()
      this.reflow()
      this.notifyCompletion()
      return
    }
    const shell =
      this.input.extmarks.getAllForTypeId(this.pastedImageType).length === 0 &&
      this.input.plainText.trimStart().startsWith("!")
    const borderColor = resolveColor(shell ? COLORS.accent : COLORS.border)
    this.prompt.content = shell ? "$" : "❯"
    this.view.borderColor = borderColor
    this.view.focusedBorderColor = borderColor
    this.syncSkillHighlights()
    this.reflow()
    this.notifyCompletion()
  }

  private notifyCompletion(): void {
    const cursor = this.input.getTextRange(0, this.input.cursorOffset).length
    this.actions.change(this.input.plainText, cursor)
  }

  private syncSkillHighlights(): void {
    for (const mark of this.input.extmarks.getAllForTypeId(this.skillHighlightType)) {
      this.input.extmarks.delete(mark.id)
    }
    const text = this.input.plainText
    for (const reference of findSkillReferences(text)) {
      this.input.extmarks.create({
        start: editorOffset(this.input, reference.start),
        end: editorOffset(this.input, reference.end),
        styleId: this.skillStyleId,
        typeId: this.skillHighlightType,
      })
    }
  }

  private paste(event: PasteEvent): void {
    event.preventDefault()
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (!text) return
    if (this.afterIme(() => this.insertPastedText(text))) return
    this.insertPastedText(text)
  }

  private insertPastedText(text: string): void {
    if (text.split(/\r\n|\r|\n/).length < 3) {
      this.input.insertText(text)
      return
    }
    const label = `[Pasted Content ${text.length} chars]`
    this.input.insertText(label)
    const end = this.input.cursorOffset
    this.input.extmarks.create({
      start: end - label.length,
      end,
      virtual: true,
      typeId: this.pastedContentType,
      data: { kind: "pasted-content", text } satisfies PastedContent,
    })
  }

  private afterIme(action: () => void): boolean {
    if (!this.imeCommit.pending) return false
    this.imeCommit.enqueue(action)
    return true
  }

  private value(): UserInput {
    let text = this.input.plainText
    const pastes = this.input.extmarks
      .getAllForTypeId(this.pastedContentType)
      .flatMap((mark) => (isPastedContent(mark.data) ? [{ ...mark, text: mark.data.text }] : []))
    const imageMarks = this.input.extmarks
      .getAllForTypeId(this.pastedImageType)
      .flatMap((mark) => (isPastedImage(mark.data) ? [{ ...mark, image: mark.data.image }] : []))
    const edits = [...pastes, ...imageMarks.map((mark) => ({ ...mark, text: "" }))].sort(
      (left, right) => right.start - left.start,
    )
    for (const edit of edits) {
      const start = this.input.getTextRange(0, edit.start).length
      const end = this.input.getTextRange(0, edit.end).length
      text = text.slice(0, start) + edit.text + text.slice(end)
    }
    return {
      text,
      images: imageMarks.sort((left, right) => left.start - right.start).map((mark) => mark.image),
    }
  }

  private submission(): UserInput {
    const input = this.value()
    return { ...input, text: input.text.trim() }
  }

  private replaceInput(input: UserInput): void {
    this.input.setText(input.text)
    this.input.gotoBufferEnd()
    input.images.forEach((image, index) => {
      if (input.text || index > 0) this.input.insertText(" ")
      this.attachImage(image)
    })
    this.input.gotoBufferEnd()
    this.reflow()
  }

  private submit(): void {
    const submission = this.submission()
    if (!submission.text && submission.images.length === 0) return
    if (submission.images.length === 0 && submission.text.startsWith("/")) {
      this.setValue("")
      this.actions.run(submission.text)
      return
    }
    if (!this.actions.submit(submission)) return
    void this.history
      .record(submission.text)
      .catch((error: unknown) => this.actions.error(`message history not saved: ${describeError(error)}`))
    this.setValue("")
  }
}
