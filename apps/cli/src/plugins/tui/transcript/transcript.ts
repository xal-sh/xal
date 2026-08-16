import {
  CliRenderEvents,
  MacOSScrollAccel,
  ScrollBoxRenderable,
  type CliRenderer,
  type Renderable,
  type RGBA,
  type TextRenderable,
} from "@opentui/core"
import { createRedactedStream, redactText, type RedactedStream } from "../../../secrets/redactor"
import type { TuiPreferences } from "../config"
import { COLORS, userMessageBackground } from "../theme/colors"
import type { Block, HeaderBlock, StreamBlock, StreamKind } from "./blocks"
import { contentWidth, renderBlock, streamContent, streamView } from "./render"

const FLUSH_MS = 50

interface RenderedBlock {
  block: Block
  view: Renderable
}

interface Stream {
  block: StreamBlock
  view: Renderable | undefined
  text: TextRenderable | undefined
  flushedAt: number
  redactor: RedactedStream
}

type Restoration =
  { type: "tail" } | { type: "top"; top: number } | { type: "bottom"; distance: number } | { type: "wheel" }

function redactBlock(block: HeaderBlock): HeaderBlock
function redactBlock(block: Block): Block
function redactBlock(block: Block): Block {
  switch (block.kind) {
    case "banner":
      return { ...block, model: redactText(block.model), cwd: redactText(block.cwd) }
    case "user":
    case "info":
    case "error":
    case "text":
    case "reasoning":
      return { ...block, text: redactText(block.text) }
    case "notice":
      return {
        ...block,
        summary: redactText(block.summary),
        details: block.details.map(redactText),
      }
    case "compaction":
      return { ...block, summary: redactText(block.summary) }
    case "background":
      return {
        ...block,
        label: redactText(block.label),
        output: redactText(block.output),
        ...(block.record === undefined ? {} : { record: redactText(block.record) }),
      }
    case "plan":
      return { ...block, path: redactText(block.path), text: redactText(block.text) }
    case "tool":
      return { ...block, title: redactText(block.title), output: redactText(block.output) }
  }
}

export class Transcript {
  readonly view: ScrollBoxRenderable
  private readonly blocks: Block[] = []
  private readonly header: HeaderBlock[] = []
  private readonly rendered: RenderedBlock[] = []
  private stream: Stream | undefined
  private expanded: boolean
  private reasoningVisible: boolean
  private userBackground = userMessageBackground(COLORS.background)
  private following = true
  private generation = 0
  private pendingFrame: (() => void) | undefined
  private pendingRestoration: Restoration | undefined
  private measuredContentRows = 0
  private contentInvalidated = false

  constructor(
    private readonly renderer: CliRenderer,
    preferences: TuiPreferences,
    private readonly detailsShortcut: string | undefined,
    private readonly onContentRowsChanged: () => void,
  ) {
    this.expanded = preferences.showOutputs
    this.reasoningVisible = preferences.showThinking
    this.view = new ScrollBoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      scrollX: false,
      scrollY: true,
      scrollAcceleration: new MacOSScrollAccel(),
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      contentOptions: { flexDirection: "column" },
    })
    this.view.focusable = false
    this.view.horizontalScrollBar.focusable = false
    this.view.horizontalScrollBar.visible = false
    this.view.verticalScrollBar.focusable = false
    this.view.verticalScrollBar.visible = false
    this.view.onMouseScroll = () => this.schedule({ type: "wheel" })
  }

  get contentRows(): number {
    return this.measuredContentRows
  }

  setTerminalBackground(background: RGBA): boolean {
    const next = userMessageBackground(background)
    if (this.userBackground.equals(next)) return false
    this.userBackground = next
    return this.blocks.some((block) => block.kind === "user")
  }

  append(block: Block): void {
    this.appendBlock(redactBlock(block))
  }

  appendHeader(block: HeaderBlock): void {
    const redacted = redactBlock(block)
    this.header.push(redacted)
    this.appendBlock(redacted)
  }

  appendStream(kind: StreamKind, delta: string): void {
    if (this.stream && this.stream.block.kind !== kind) this.endStream()
    const stream = this.stream ?? this.beginStream(kind)
    stream.block.text += stream.redactor.write(delta)
    const now = Date.now()
    if (now - stream.flushedAt < FLUSH_MS) return
    stream.flushedAt = now
    this.flush(stream)
  }

  endStream(): boolean {
    const stream = this.stream
    if (!stream) return false
    this.stream = undefined
    stream.block.text += stream.redactor.end()
    if (stream.block.text.length === 0) {
      this.drop(stream.block)
      return false
    }
    if (this.visible(stream.block)) this.flush(stream)
    return true
  }

  clear(): void {
    this.endStream()
    this.blocks.length = 0
    this.header.length = 0
    this.following = true
    this.destroyRendered()
    this.invalidateContent()
    this.schedule({ type: "tail" })
  }

  clearTranscript(): void {
    this.endStream()
    this.blocks.length = 0
    this.blocks.push(...this.header)
    this.following = true
    this.replaceRendered()
    this.schedule({ type: "tail" })
  }

  toggleExpanded(): void {
    this.setExpanded(!this.expanded)
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    this.rebuild()
  }

  setReasoningVisible(visible: boolean): void {
    if (this.reasoningVisible === visible) return
    this.reasoningVisible = visible
    this.rebuild()
  }

  rebuild(): void {
    this.syncPendingWheel()
    const restoration: Restoration = this.following
      ? { type: "tail" }
      : { type: "bottom", distance: this.maxScrollTop() - this.view.scrollTop }
    this.replaceRendered()
    this.schedule(restoration)
  }

  preserveGeometry(): void {
    this.schedule(!this.view.visible && this.pendingRestoration ? this.pendingRestoration : this.captureGeometry())
  }

  pageUp(): void {
    this.view.scrollBy(-Math.max(1, this.view.viewport.height - 1))
    this.syncFollowing()
    this.schedule(this.captureGeometry())
  }

  pageDown(): void {
    this.view.scrollBy(Math.max(1, this.view.viewport.height - 1))
    this.syncFollowing()
    this.schedule(this.captureGeometry())
  }

  scrollToStart(): void {
    this.view.scrollTo(0)
    this.syncFollowing()
    this.schedule(this.captureGeometry())
  }

  scrollToEnd(): void {
    this.following = true
    this.view.scrollTo(this.maxScrollTop())
    this.schedule({ type: "tail" })
  }

  private appendBlock(block: Block): void {
    this.endStream()
    const restoration = this.captureGeometry()
    const previous = this.blocks.findLast((candidate) => this.visible(candidate))
    this.blocks.push(block)
    if (this.visible(block)) this.addRendered(block, previous)
    this.invalidateContent()
    this.schedule(restoration)
  }

  private beginStream(kind: StreamKind): Stream {
    const restoration = this.captureGeometry()
    const block: StreamBlock = { kind, text: "" }
    const stream: Stream = {
      block,
      view: undefined,
      text: undefined,
      flushedAt: 0,
      redactor: createRedactedStream(),
    }
    this.blocks.push(block)
    this.stream = stream
    if (this.visible(block)) this.addStream(stream)
    this.invalidateContent()
    this.schedule(restoration)
    return stream
  }

  private flush(stream: Stream): void {
    if (!this.visible(stream.block)) return
    if (!stream.view || !stream.text) throw new Error("Visible transcript stream has no renderable")
    const restoration = this.captureGeometry()
    const rendered = streamContent(stream.block, contentWidth(this.renderer))
    stream.text.content = rendered.content
    stream.text.height = rendered.rows
    this.invalidateContent()
    this.schedule(restoration)
  }

  private drop(block: StreamBlock): void {
    const index = this.blocks.indexOf(block)
    if (index < 0) throw new Error("Active transcript stream is not stored")
    const restoration = this.captureGeometry()
    this.blocks.splice(index, 1)
    if (!this.visible(block)) return
    const renderedIndex = this.rendered.findIndex((candidate) => candidate.block === block)
    if (renderedIndex < 0) throw new Error("Visible transcript stream is not rendered")
    const [rendered] = this.rendered.splice(renderedIndex, 1)
    if (!rendered) throw new Error("Visible transcript stream renderable is missing")
    rendered.view.destroyRecursively()
    this.invalidateContent()
    this.schedule(restoration)
  }

  private replaceRendered(): void {
    this.destroyRendered()
    const stream = this.stream
    let previous: Block | undefined
    for (const block of this.blocks) {
      if (!this.visible(block)) continue
      if (stream && block === stream.block) this.addStream(stream)
      else this.addRendered(block, previous)
      previous = block
    }
    this.invalidateContent()
  }

  private destroyRendered(): void {
    if (this.stream) {
      this.stream.view = undefined
      this.stream.text = undefined
    }
    for (const rendered of this.rendered.splice(0)) rendered.view.destroyRecursively()
  }

  private addRendered(block: Block, previous: Block | undefined): void {
    const view = renderBlock(this.renderer, block, this.expanded, this.userBackground, this.detailsShortcut, previous)
    this.view.add(view)
    this.rendered.push({ block, view })
  }

  private addStream(stream: Stream): void {
    if (stream.view || stream.text) throw new Error("Transcript stream already has a renderable")
    const rendered = streamView(this.renderer, stream.block)
    stream.view = rendered.view
    stream.text = rendered.text
    this.view.add(rendered.view)
    this.rendered.push({ block: stream.block, view: rendered.view })
  }

  private visible(block: Block): boolean {
    return block.kind !== "reasoning" || this.reasoningVisible
  }

  private captureGeometry(): Restoration {
    this.syncPendingWheel()
    return this.following ? { type: "tail" } : { type: "top", top: this.view.scrollTop }
  }

  private syncPendingWheel(): void {
    if (this.pendingRestoration?.type === "wheel") this.syncFollowing()
  }

  private schedule(restoration: Restoration): void {
    const generation = ++this.generation
    this.pendingRestoration = restoration
    if (this.pendingFrame) this.renderer.off(CliRenderEvents.FRAME, this.pendingFrame)
    const complete = (): void => {
      if (this.pendingFrame === complete) this.pendingFrame = undefined
      if (generation !== this.generation || this.renderer.isDestroyed || this.view.isDestroyed) return
      if (!this.view.visible) return
      this.pendingRestoration = undefined
      switch (restoration.type) {
        case "tail":
          this.following = true
          this.view.scrollTo(this.maxScrollTop())
          break
        case "top":
          this.following = false
          this.view.scrollTo(restoration.top)
          break
        case "bottom":
          this.following = false
          this.view.scrollTo(this.maxScrollTop() - restoration.distance)
          break
        case "wheel":
          this.syncFollowing()
          break
      }
      this.measureContent()
    }
    this.pendingFrame = complete
    this.renderer.once(CliRenderEvents.FRAME, complete)
    this.renderer.requestRender()
  }

  private maxScrollTop(): number {
    return Math.max(0, this.view.scrollHeight - this.view.viewport.height)
  }

  private syncFollowing(): void {
    this.following = this.view.scrollTop >= this.maxScrollTop()
  }

  private invalidateContent(): void {
    this.contentInvalidated = true
  }

  private measureContent(): void {
    if (!this.contentInvalidated) return
    this.contentInvalidated = false
    const last = this.rendered.at(-1)
    const rows = last ? last.view.y + last.view.height : 0
    if (rows === this.measuredContentRows) return
    this.measuredContentRows = rows
    this.onContentRowsChanged()
  }
}
