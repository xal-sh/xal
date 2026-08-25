import type { CliRenderer, RGBA, ScrollbackSurface, TextRenderable } from "@opentui/core"
import { createRedactedStream, redactText, type RedactedStream } from "../../../secrets/redactor"
import type { TuiPreferences } from "../config"
import type { RenderedMarkdown } from "../markdown/render"
import { COLORS, userMessageBackground } from "../theme/colors"
import { blockVisible, type Block, type HeaderBlock, type StreamBlock, type StreamKind } from "./blocks"
import { contentWidth, renderBlock, streamContent, streamRowColumns, streamView } from "./render"

const FLUSH_MS = 50

interface Stream {
  block: StreamBlock
  surface?: ScrollbackSurface
  text?: TextRenderable
  committed: number
  flushedAt: number
  redactor: RedactedStream
}

interface TranscriptCheckpoint {
  messageId: string
  before: Block[]
}

interface TranscriptRedo {
  messageId: string
  blocks: Block[]
  checkpoints: TranscriptCheckpoint[]
}

function redactBlock(block: Block): Block {
  switch (block.kind) {
    case "banner":
      return { ...block, model: redactText(block.model), cwd: redactText(block.cwd) }
    case "user":
    case "info":
    case "hook":
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
      return block.state === "compacting" ? block : { ...block, summary: redactText(block.summary) }
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

export class Scrollback {
  private readonly blocks: Block[] = []
  private readonly checkpoints: TranscriptCheckpoint[] = []
  private readonly header: Block[] = []
  private readonly redos: TranscriptRedo[] = []
  private stream: Stream | undefined
  private expanded: boolean
  private reasoningVisible: boolean
  private committed = 0
  private origin: number
  private active = true
  private deferred = false
  private userBackground = userMessageBackground(COLORS.background)

  constructor(
    private readonly renderer: CliRenderer,
    startRow: number,
    private readonly onCommit: (rows: number) => void,
    config: TuiPreferences,
    private readonly detailsShortcut: string | undefined,
  ) {
    this.origin = startRow
    this.expanded = config.showOutputs
    this.reasoningVisible = config.showThinking
  }

  get rows(): number {
    return this.origin + this.committed
  }

  get endsWithTool(): boolean {
    return this.blocks.findLast((block) => this.visible(block))?.kind === "tool"
  }

  setTerminalBackground(background: RGBA): boolean {
    const next = userMessageBackground(background)
    if (this.userBackground.equals(next)) return false
    this.userBackground = next
    return this.blocks.some((block) => block.kind === "user")
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (!active) {
      this.stream?.surface?.destroy()
      if (this.stream) {
        this.stream.surface = undefined
        this.stream.text = undefined
        this.stream.committed = 0
      }
      return
    }
    this.replay()
  }

  append(block: Block): void {
    this.appendBlock(redactBlock(block))
  }

  appendHeader(block: HeaderBlock): void {
    const redacted = redactBlock(block)
    this.header.push(redacted)
    this.appendBlock(redacted)
  }

  checkpoint(messageId: string): void {
    this.endStream()
    this.redos.length = 0
    this.checkpoints.push({ messageId, before: [...this.blocks] })
  }

  rewind(messageId: string): void {
    this.endStream()
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.messageId === messageId)
    if (index < 0) throw new Error("TUI transcript and conversation history disagree")

    const checkpoints = [...this.checkpoints]
    const blocks = [...this.blocks]
    const removed = checkpoints.slice(index)
    this.redos.push(
      ...removed
        .map((checkpoint, offset): TranscriptRedo => ({
          messageId: checkpoint.messageId,
          blocks: [...(removed[offset + 1]?.before ?? blocks)],
          checkpoints: checkpoints.slice(0, index + offset + 1),
        }))
        .toReversed(),
    )
    this.restore(removed[0]!.before, checkpoints.slice(0, index))
  }

  redo(messageId: string): void {
    this.endStream()
    const redo = this.redos.at(-1)
    if (!redo || redo.messageId !== messageId) throw new Error("TUI transcript and conversation redo history disagree")
    this.redos.pop()
    this.restore(redo.blocks, redo.checkpoints)
  }

  appendStream(kind: StreamKind, delta: string): void {
    if (this.stream && this.stream.block.kind !== kind) this.endStream()
    const stream = this.stream ?? this.beginStream(kind)
    stream.block.text += stream.redactor.write(delta)
    const now = Date.now()
    if (now - stream.flushedAt < FLUSH_MS) return
    stream.flushedAt = now
    this.flush(stream, false)
  }

  endStream(): boolean {
    const stream = this.stream
    if (!stream) return false
    this.stream = undefined
    stream.block.text += stream.redactor.end()
    const flushed = stream.block.text.length > 0
    if (flushed) this.flush(stream, true)
    else this.drop(stream.block)
    stream.surface?.destroy()
    return flushed
  }

  beginReplay(): void {
    this.deferred = true
  }

  endReplay(): void {
    if (!this.deferred) return
    this.deferred = false
    if (!this.active) return
    this.emitTranscript(false)
  }

  clear(): void {
    this.endStream()
    this.blocks.length = 0
    this.checkpoints.length = 0
    this.header.length = 0
    this.redos.length = 0
    if (this.deferred) {
      this.origin = this.rows
      this.committed = 0
      return
    }
    this.reset()
    if (this.active) this.renderer.resetSplitFooterForReplay({ clearSavedLines: true })
  }

  clearTranscript(): void {
    this.endStream()
    this.blocks.length = 0
    this.blocks.push(...this.header)
    for (const checkpoint of this.checkpoints) checkpoint.before = [...this.header]
    for (const redo of this.redos) {
      redo.blocks = [...this.header]
      redo.checkpoints = redo.checkpoints.map((checkpoint) => ({ ...checkpoint, before: [...this.header] }))
    }
    this.replay()
  }

  toggleExpanded(): void {
    this.setExpanded(!this.expanded)
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return
    this.expanded = expanded
    this.replay()
  }

  setReasoningVisible(visible: boolean): void {
    if (this.reasoningVisible === visible) return
    this.reasoningVisible = visible
    this.replay()
  }

  replay(): void {
    this.replayBlocks(true)
  }

  replayViewport(): void {
    this.replayBlocks(false)
  }

  private replayBlocks(fromStart: boolean): void {
    if (!this.emitting) return
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: fromStart })
    this.reset()
    this.emitTranscript(fromStart)
  }

  private emitTranscript(fromStart: boolean): void {
    const streaming = this.stream
    if (streaming) {
      streaming.surface?.destroy()
      this.stream = undefined
    }
    const blocks = this.blocks.filter((block) => block !== streaming?.block && this.visible(block))
    if (fromStart) {
      for (const [index, block] of blocks.entries()) this.emit(block, blocks[index - 1])
    } else {
      this.emitBatch(blocks, this.viewportStart(blocks))
    }
    if (!streaming) return
    this.stream = this.openRedactedStream(streaming.block, streaming.redactor)
    this.flush(this.stream, false, !fromStart)
  }

  private emitBatch(blocks: Block[], start: number): void {
    if (start >= blocks.length) return
    const surface = this.renderer.createScrollbackSurface()
    try {
      for (let index = start; index < blocks.length; index += 1) {
        surface.root.add(
          renderBlock(
            surface.renderContext,
            blocks[index]!,
            this.expanded,
            this.userBackground,
            this.detailsShortcut,
            blocks[index - 1],
          ),
        )
      }
      surface.render()
      this.onCommit(surface.height)
      surface.commitRows(0, surface.height, { trailingNewline: false })
      this.committed += surface.height
    } finally {
      surface.destroy()
    }
  }

  private viewportStart(blocks: Block[]): number {
    let rows = 0
    for (let index = blocks.length - 1; index > 0; index -= 1) {
      rows += this.measure(blocks[index]!, blocks[index - 1])
      if (rows >= this.renderer.terminalHeight * 2) return index
    }
    return 0
  }

  private measure(block: Block, previous: Block | undefined): number {
    const surface = this.renderer.createScrollbackSurface()
    try {
      surface.root.add(
        renderBlock(surface.renderContext, block, this.expanded, this.userBackground, this.detailsShortcut, previous),
      )
      surface.render()
      return surface.height
    } finally {
      surface.destroy()
    }
  }

  private restore(blocks: Block[], checkpoints: TranscriptCheckpoint[]): void {
    this.blocks.length = 0
    this.blocks.push(...blocks)
    this.checkpoints.length = 0
    this.checkpoints.push(...checkpoints)
    this.replay()
  }

  private reset(): void {
    this.origin = 0
    this.committed = 0
  }

  private liveRows(): number {
    return Math.max(1, this.renderer.terminalHeight - this.renderer.footerHeight - 1)
  }

  private get emitting(): boolean {
    return this.active && !this.deferred
  }

  private appendBlock(block: Block): void {
    this.endStream()
    const previous = this.blocks.findLast((candidate) => this.visible(candidate))
    this.blocks.push(block)
    if (this.emitting) this.emit(block, previous)
  }

  private drop(block: Block): void {
    const index = this.blocks.indexOf(block)
    if (index < 0) return
    this.blocks.splice(index, 1)
  }

  private beginStream(kind: StreamKind): Stream {
    const block: StreamBlock = { kind, text: "" }
    this.blocks.push(block)
    this.stream = this.openStream(block)
    return this.stream
  }

  private openStream(block: StreamBlock): Stream {
    return this.openRedactedStream(block, createRedactedStream())
  }

  private openRedactedStream(block: StreamBlock, redactor: RedactedStream): Stream {
    if (!this.emitting) return { block, committed: 0, flushedAt: 0, redactor }
    const surface = this.renderer.createScrollbackSurface()
    const { view, text } = streamView(surface.renderContext, block)
    surface.root.add(view)
    return { block, surface, text, committed: 0, flushedAt: 0, redactor }
  }

  private flush(stream: Stream, final: boolean, batch = false): void {
    if (!this.emitting || !stream.surface || !stream.text || !this.visible(stream.block)) return
    const rendered = streamContent(stream.block, contentWidth(stream.surface.renderContext))
    stream.text.content = rendered.content
    stream.text.height = rendered.rows
    stream.surface.render()
    const pending = rendered.rows - rendered.stable
    const held = final ? 0 : rendered.flowing ? Math.max(1, Math.min(pending, this.liveRows())) : pending
    const target = stream.surface.height - held
    if (target <= stream.committed) return
    const rows = target - stream.committed
    this.onCommit(rows)
    if (batch) stream.surface.commitRows(stream.committed, target, { trailingNewline: true })
    else this.commitStreamRows(stream.surface, rendered, stream.committed, target, final)
    this.committed += rows
    stream.committed = target
  }

  private emit(block: Block, previous: Block | undefined): void {
    if (!this.visible(block)) return
    if (block.kind === "text" || block.kind === "reasoning") {
      this.emitStream(block)
      return
    }
    const surface = this.renderer.createScrollbackSurface()
    try {
      surface.root.add(
        renderBlock(surface.renderContext, block, this.expanded, this.userBackground, this.detailsShortcut, previous),
      )
      surface.render()
      this.onCommit(surface.height)
      surface.commitRows(0, surface.height, { trailingNewline: false })
      this.committed += surface.height
    } finally {
      surface.destroy()
    }
  }

  private emitStream(block: StreamBlock): void {
    const surface = this.renderer.createScrollbackSurface()
    try {
      const { view, rendered } = streamView(surface.renderContext, block)
      surface.root.add(view)
      surface.render()
      this.onCommit(surface.height)
      this.commitStreamRows(surface, rendered, 0, surface.height, true)
      this.committed += surface.height
    } finally {
      surface.destroy()
    }
  }

  private commitStreamRows(
    surface: ScrollbackSurface,
    rendered: RenderedMarkdown,
    startRow: number,
    endRowExclusive: number,
    final: boolean,
  ): void {
    const columns = streamRowColumns(rendered, surface.height)
    for (let row = startRow; row < endRowExclusive; row += 1) {
      surface.commitRows(row, row + 1, {
        rowColumns: columns[row],
        trailingNewline: !final || row + 1 < endRowExclusive,
      })
    }
  }

  private visible(block: Block): boolean {
    return blockVisible(block, this.expanded, this.reasoningVisible)
  }
}
