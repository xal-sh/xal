import { basename } from "node:path"
import {
  RenderableEvents,
  StyledText,
  type BoxRenderable,
  type RenderContext,
  type TextRenderable,
} from "@opentui/core"
import { listCommands } from "../../../commands/registry"
import type { Command } from "../../../commands/types"
import { describeError } from "../../../lib/error"
import { redactText } from "../../../secrets/redactor"
import { skillQuery, type SkillQuery } from "../../../skills/references"
import { listSkills } from "../../../skills/registry"
import type { Skill } from "../../../skills/types"
import { fileQuery, type FileQuery, WorkspaceFileIndex } from "../file-search"
import { fuzzyScores } from "../lib/fuzzy"
import { column, label, row } from "../lib/renderables"
import { displayWidth, truncateToWidth } from "../lib/text"
import { COLORS } from "../theme/colors"
import { background, border, muted, paint } from "../theme/styles"

export const PALETTE_CHROME_ROWS = 3

const MAX_ROWS = 6
const MAX_FILE_RESULTS = 20
const NAME_WIDTH = 22
const TICKER_INTERVAL_MS = 120
const TICKER_PAUSE_FRAMES = 8

type Completion =
  { kind: "command"; command: Command } | { kind: "skill"; skill: Skill } | { kind: "file"; path: string }

interface CompletionRow {
  view: BoxRenderable
  name: TextRenderable
  description: TextRenderable
  descriptionText: string
  selected: boolean
}

interface CompletionPaletteActions {
  completeCommand(line: string): void
  completeSkill(query: SkillQuery, name: string, trailingSpace: boolean): void
  completeFile(query: FileQuery, path: string): void
  runCommand(line: string): void
  error(message: string): void
}

function skillCompletions(query: string): Completion[] {
  const skills = listSkills().filter((skill) => redactText(skill.name) === skill.name)
  const scores = fuzzyScores(
    query,
    skills.map((skill) => [{ text: skill.name, weight: 1 }]),
  )
  return skills
    .flatMap((skill, index) => {
      const rank = scores[index]
      return rank === undefined ? [] : [{ skill, rank }]
    })
    .sort((left, right) => right.rank - left.rank || left.skill.name.localeCompare(right.skill.name))
    .map(({ skill }) => ({ kind: "skill", skill }))
}

function commandCompletions(value: string, cursor: number): Completion[] | undefined {
  if (cursor !== value.length || !value.startsWith("/")) return undefined
  const query = value.slice(1)
  if (/\s/.test(query)) return undefined
  const needle = query.toLowerCase()
  return listCommands()
    .filter(
      (command) =>
        !command.hidden &&
        redactText(command.name) === command.name &&
        [command.name, ...(command.aliases ?? [])].some((name) => name.toLowerCase().includes(needle)),
    )
    .map((command) => ({ kind: "command", command }))
}

function completionText(entry: Completion): { name: string; description: string } {
  if (entry.kind === "command") {
    return { name: redactText(`/${entry.command.name}`), description: redactText(entry.command.describe) }
  }
  if (entry.kind === "file") {
    return { name: redactText(`@${basename(entry.path)}`), description: redactText(entry.path) }
  }
  return {
    name: redactText(`$${entry.skill.name}`),
    description: redactText(entry.skill.description.replace(/\s+/g, " ")),
  }
}

export class CompletionPalette {
  readonly view: BoxRenderable
  private readonly options: BoxRenderable
  private readonly rows: CompletionRow[] = []
  private readonly fileIndex = new WorkspaceFileIndex()
  private entries: Completion[] = []
  private skillQuery: SkillQuery | undefined
  private activeFileQuery: FileQuery | undefined
  private fileRequest = 0
  private selected = 0
  private offset = 0
  private limit = MAX_ROWS
  private tickerFrame = 0
  private tickerTimer: ReturnType<typeof setInterval> | undefined

  get visible(): boolean {
    return this.view.visible
  }

  get height(): number {
    return this.rowCount + PALETTE_CHROME_ROWS
  }

  private get rowCount(): number {
    return Math.min(this.entries.length, this.limit)
  }

  constructor(
    ctx: RenderContext,
    private workingDirectory: string,
    private readonly actions: CompletionPaletteActions,
    private readonly onChange: () => void,
  ) {
    this.view = row(ctx, {
      visible: false,
      border: true,
      borderStyle: "rounded",
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      ...background(),
      ...border(COLORS.accent),
    })
    this.options = column(ctx, { flexGrow: 1, flexShrink: 1, minWidth: 1 })

    this.view.add(this.options)

    for (let index = 0; index < MAX_ROWS; index++) {
      const option = row(ctx, { visible: false })
      const name = label(ctx, { content: "", flexShrink: 0 })
      const description = label(ctx, {
        content: "",
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 1,
        truncate: false,
      })
      option.add(name)
      option.add(description)
      const line = { view: option, name, description, descriptionText: "", selected: false }
      description.on("line-info-change", () => this.renderDescription(line, false))
      this.rows.push(line)
      this.options.add(option)
    }
    this.view.on(RenderableEvents.DESTROYED, () => {
      this.resetFileSearch()
      this.stopTicker()
    })
  }

  setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd
    this.dismiss()
  }

  update(value: string, cursor: number, limit: number): void {
    const activeFileQuery = fileQuery(value, cursor)
    if (activeFileQuery) {
      this.updateFiles(activeFileQuery, limit)
      return
    }

    this.resetFileSearch()
    const activeSkillQuery = skillQuery(value, cursor)
    const entries = activeSkillQuery ? skillCompletions(activeSkillQuery.query) : commandCompletions(value, cursor)
    if (!entries || entries.length === 0) {
      this.hide()
      return
    }

    this.skillQuery = activeSkillQuery
    this.show(entries, limit)
  }

  private hide(): void {
    if (!this.view.visible) return
    this.view.visible = false
    this.stopTicker()
    this.onChange()
  }

  dismiss(): void {
    this.resetFileSearch()
    this.hide()
  }

  handleKey(name: string): boolean {
    if (name === "escape" && this.activeFileQuery) {
      this.dismiss()
      return true
    }
    if (!this.view.visible) return false
    if (name === "up") {
      this.move(-1)
      return true
    }
    if (name === "down") {
      this.move(1)
      return true
    }
    if (name === "escape") {
      this.dismiss()
      return true
    }
    if (name === "tab") {
      this.complete(this.entries[this.selected], true)
      return true
    }
    if (name === "right") return this.completeSkill(this.entries[this.selected], false)
    if (name === "return" || name === "enter") {
      return this.confirm(this.entries[this.selected])
    }
    return false
  }

  private updateFiles(query: FileQuery, limit: number): void {
    if (this.entries[0]?.kind !== "file") this.hide()
    this.skillQuery = undefined
    this.activeFileQuery = query
    const request = ++this.fileRequest

    void this.fileIndex
      .search(this.workingDirectory, query.query)
      .then((paths) => {
        const current = request === this.fileRequest && this.activeFileQuery === query
        if (!paths || !current) return
        const entries: Completion[] = paths.slice(0, MAX_FILE_RESULTS).map((path) => ({ kind: "file", path }))
        if (entries.length === 0) {
          this.hide()
          return
        }
        this.show(entries, limit)
      })
      .catch((error: unknown) => {
        if (request !== this.fileRequest) return
        this.resetFileSearch()
        this.hide()
        this.actions.error(`file search failed: ${describeError(error)}`)
      })
  }

  private resetFileSearch(): void {
    if (!this.activeFileQuery) return
    this.fileRequest++
    this.activeFileQuery = undefined
    this.fileIndex.clear()
  }

  private show(entries: Completion[], limit: number): void {
    const previous = this.view.visible ? this.rowCount : 0
    this.limit = Math.max(1, Math.min(MAX_ROWS, limit))
    this.entries = entries
    this.selected = 0
    this.offset = 0
    this.stopTicker()
    this.renderOptions()
    this.view.height = this.rowCount + 2
    this.view.visible = true
    this.startTicker()
    if (this.rowCount !== previous) this.onChange()
  }

  private move(delta: number): void {
    const count = this.entries.length
    this.selected = (this.selected + delta + count) % count
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + this.rowCount) this.offset = this.selected - this.rowCount + 1
    this.stopTicker()
    this.renderOptions()
    this.startTicker()
  }

  private complete(entry: Completion | undefined, trailingSpace: boolean): void {
    if (!entry) return
    if (entry.kind === "command") {
      this.actions.completeCommand(`/${entry.command.name} `)
    } else if (entry.kind === "skill") {
      this.completeSkill(entry, trailingSpace)
    } else if (this.activeFileQuery) {
      this.actions.completeFile(this.activeFileQuery, entry.path)
      this.dismiss()
      return
    }
    this.hide()
  }

  private completeSkill(entry: Completion | undefined, trailingSpace: boolean): boolean {
    if (entry?.kind !== "skill" || !this.skillQuery) return false
    this.actions.completeSkill(this.skillQuery, entry.skill.name, trailingSpace)
    return true
  }

  private confirm(entry: Completion | undefined): boolean {
    if (!entry) return false
    if (entry.kind !== "command") {
      this.complete(entry, true)
      return true
    }
    this.hide()
    this.actions.runCommand(`/${entry.command.name}`)
    return true
  }

  private renderOptions(): void {
    this.rows.forEach((line, index) => {
      const entry = index < this.rowCount ? this.entries[this.offset + index] : undefined
      if (!entry) {
        line.view.visible = false
        line.descriptionText = ""
        line.selected = false
        line.description.scrollX = 0
        return
      }
      line.view.visible = true
      const entryText = completionText(entry)
      const position = this.offset + index
      const name = `${position === this.selected ? "❯ " : "  "}${entryText.name}${" ".repeat(
        Math.max(2, NAME_WIDTH - displayWidth(entryText.name)),
      )}`
      line.name.width = displayWidth(name)
      line.name.content = new StyledText([position === this.selected ? paint(COLORS.accent, name) : muted(name)])
      line.descriptionText = entryText.description
      line.selected = position === this.selected
      this.renderDescription(line, true)
      line.description.scrollX = 0
    })
  }

  private renderDescription(line: CompletionRow, force: boolean): void {
    const text = line.selected ? line.descriptionText : truncateToWidth(line.descriptionText, line.description.width)
    if (!force && line.description.plainText === text) return
    line.description.content = new StyledText([line.selected ? paint(COLORS.accent, text) : muted(text)])
  }

  private startTicker(): void {
    if (this.tickerTimer) return
    this.tickerTimer = setInterval(() => {
      this.tickerFrame++
      const line = this.rows[this.selected - this.offset]
      if (!line?.view.visible) return
      const width = line.description.maxScrollX
      if (width === 0) return
      const frame = this.tickerFrame % (width + TICKER_PAUSE_FRAMES * 2)
      line.description.scrollX =
        frame <= TICKER_PAUSE_FRAMES ? 0 : frame <= TICKER_PAUSE_FRAMES + width ? frame - TICKER_PAUSE_FRAMES : width
    }, TICKER_INTERVAL_MS)
  }

  private stopTicker(): void {
    if (this.tickerTimer) clearInterval(this.tickerTimer)
    this.tickerTimer = undefined
    this.tickerFrame = 0
    for (const line of this.rows) line.description.scrollX = 0
  }
}
