import type { BoxRenderable, CliRenderer } from "@opentui/core"
import type { AgentSession } from "../../agent/session/session"
import type { BackgroundTask } from "../../background/registry"
import { runCommand } from "../../commands/run"
import type { CommandContext, SelectRequest } from "../../commands/types"
import { describeError } from "../../lib/error"
import { compactPath } from "../../lib/path"
import type { PermissionMode } from "../../permissions/types"
import type { ThinkingEffort, UserInput } from "../../providers/types"
import { protectSecretValue, redactText } from "../../secrets/redactor"
import type { ElicitationQuestion } from "../../tools/types"
import { JobViewer } from "./components/job-viewer"
import { BackgroundTasks } from "./components/background-tasks"
import { Composer } from "./components/composer"
import { ConfigPopover } from "./components/config-popover"
import { CompletionPalette, PALETTE_CHROME_ROWS } from "./components/completion-palette"
import { ElicitationPopover, type ElicitationPopoverActions } from "./components/elicitation-popover"
import { LiveTools } from "./components/live-tools"
import { Picker } from "./components/picker"
import { PermissionPopover, type PermissionPopoverActions } from "./components/permission-popover"
import { QueuedInputs } from "./components/queued-inputs"
import { SecretInput } from "./components/secret-input"
import { ShortcutHelp } from "./components/shortcut-help"
import { StatusBar, STATUS_ROWS } from "./components/status-bar"
import { TaskList } from "./components/task-list"
import { saveTuiConfig, type TuiConfig } from "./config"
import { column } from "./lib/renderables"
import type { MessageHistory } from "./message-history"
import { Scrollback } from "./scrollback/scrollback"
import type { ResolvedShortcuts } from "./shortcuts"
import { sessionTerminalTitle } from "./terminal"

export interface ScreenActions extends PermissionPopoverActions, ElicitationPopoverActions {
  submit(input: UserInput): boolean
}

const SCROLLBACK_GAP_ROWS = 1

type ScreenPage = { kind: "main" } | { kind: "job" }

export function mainFooterHeight(
  terminalHeight: number,
  scrollbackRows: number,
  contentRows: number,
  liveRows: number,
): number {
  if (liveRows === 0) return contentRows
  return Math.max(contentRows, terminalHeight - scrollbackRows)
}

export class Screen {
  readonly view: BoxRenderable
  private readonly mainPanel: BoxRenderable
  readonly scrollback: Scrollback
  readonly jobViewer: JobViewer
  readonly live: LiveTools
  readonly queued: QueuedInputs
  readonly permission: PermissionPopover
  readonly elicitation: ElicitationPopover
  readonly secret: SecretInput
  readonly picker: Picker
  readonly config: ConfigPopover
  readonly palette: CompletionPalette
  readonly composer: Composer
  readonly statusBar: StatusBar
  readonly tasks: BackgroundTasks
  readonly taskList: TaskList
  private readonly shortcutHelp: ShortcutHelp
  private overlaid = false
  private paletteBelow = true
  private pendingScrollbackRows = 0
  private reserved = 0
  private page: ScreenPage = { kind: "main" }
  private sessionTitle: string | undefined
  private cwd: string

  constructor(
    private readonly renderer: CliRenderer,
    private readonly session: AgentSession,
    startRow: number,
    private readonly history: MessageHistory,
    preferences: TuiConfig,
    shortcuts: ResolvedShortcuts,
    actions: ScreenActions,
  ) {
    this.cwd = redactText(session.currentWorkingDirectory)
    this.scrollback = new Scrollback(
      renderer,
      startRow,
      (rows) => this.reclaim(rows),
      preferences,
      shortcuts.help("display.toggle-details"),
    )
    this.view = column(renderer, { width: "100%", height: "100%" })
    this.jobViewer = new JobViewer(renderer, (message) => this.statusBar.setNotice(message))
    this.live = new LiveTools(renderer, () => this.syncFooter(), shortcuts.help("jobs.background"))
    this.queued = new QueuedInputs(renderer, () => this.syncFooter())
    this.taskList = new TaskList(renderer, () => this.syncFooter())
    this.permission = new PermissionPopover(renderer, actions)
    this.elicitation = new ElicitationPopover(
      renderer,
      actions,
      () => this.syncFooter(),
      () => this.elicitationAvailableHeight(),
    )
    this.secret = new SecretInput(renderer, () => this.syncFooter())
    this.picker = new Picker(renderer, () => this.syncFooter())
    this.config = new ConfigPopover(
      renderer,
      {
        showOutputs: preferences.showOutputs,
        showThinking: preferences.showThinking,
        scrollbackRows: preferences.scrollbackRows,
      },
      {
        change: async (config, key) => {
          await saveTuiConfig(config)
          switch (key) {
            case "showOutputs":
              this.scrollback.setExpanded(config.showOutputs)
              return
            case "showThinking":
              this.scrollback.setReasoningVisible(config.showThinking)
              return
          }
        },
        changed: () => this.syncFooter(),
        error: (message) => this.scrollback.append({ kind: "error", text: message }),
      },
    )
    this.palette = new CompletionPalette(
      renderer,
      session.currentWorkingDirectory,
      {
        completeCommand: (line) => this.composer.setValue(line),
        completeSkill: (query, name, trailingSpace) => this.composer.completeSkill(query, name, trailingSpace),
        completeFile: (query, path) => this.composer.completeFile(query, path),
        runCommand: (line) => this.runCommand(line),
        error: (message) => this.scrollback.append({ kind: "error", text: message }),
      },
      () => this.syncFooter(),
    )
    this.statusBar = new StatusBar(renderer, session.currentModel, session.currentThinking, session.currentMode)
    this.shortcutHelp = new ShortcutHelp(renderer, shortcuts, () => this.syncFooter())
    this.composer = new Composer(renderer, history, {
      submit: (input) => {
        if (input.images.length === 0 || this.session.supportsImageInput) {
          return actions.submit(input)
        }
        this.scrollback.append({
          kind: "error",
          text: `${this.session.currentModel} does not support image input`,
        })
        return false
      },
      run: (line) => this.runCommand(line),
      error: (message) => this.scrollback.append({ kind: "error", text: message }),
      change: (value, cursor) => {
        const help = value.startsWith("?")
        if (this.shortcutHelp.setActive(help)) this.syncFooter()
        if (help) {
          this.palette.dismiss()
          return
        }
        this.placePalette()
        this.palette.update(value, cursor, this.paletteLimit())
      },
      resize: () => this.syncFooter(),
    })
    this.tasks = new BackgroundTasks(
      renderer,
      {
        changed: () => {
          this.jobViewer.refresh()
          this.syncFooter()
        },
        released: () => {
          if (!this.overlayVisible) this.composer.focus()
        },
        viewJob: (task) => this.viewJob(task),
        scrollViewer: (name) => this.jobViewer.scrollKey(name),
        error: (message) => this.scrollback.append({ kind: "error", text: message }),
      },
      shortcuts.help("agents.stop-all"),
      () => this.session.id,
    )

    this.mainPanel = column(renderer, { paddingLeft: 2, paddingRight: 2, marginBottom: "auto" })
    this.mainPanel.add(this.live.view)
    this.mainPanel.add(this.queued.view)
    this.mainPanel.add(this.taskList.view)
    this.view.add(this.mainPanel)
    this.view.add(this.permission.view)
    this.view.add(this.elicitation.view)
    this.view.add(this.secret.view)
    this.view.add(this.picker.view)
    this.view.add(this.config.view)
    this.view.add(this.jobViewer.view)
    this.view.add(this.composer.view)
    this.view.add(this.shortcutHelp.view)
    this.view.add(this.palette.view)
    this.view.add(this.statusBar.view)
    this.view.add(this.tasks.view)
    this.syncFooter()
  }

  get overlayVisible(): boolean {
    return (
      this.permission.visible ||
      this.elicitation.visible ||
      this.secret.visible ||
      this.picker.visible ||
      this.config.visible
    )
  }

  requestApproval(suggestion: string | undefined): void {
    this.tasks.closeViewer()
    this.config.hide()
    this.picker.hide()
    this.permission.show(suggestion)
    this.syncFooter()
  }

  dismissApproval(): void {
    this.permission.hide()
    this.syncFooter()
  }

  requestElicitation(requestId: string, questions: ElicitationQuestion[]): void {
    this.tasks.closeViewer()
    this.config.hide()
    this.picker.hide()
    this.elicitation.show(requestId, questions)
    this.syncFooter()
  }

  dismissElicitation(): void {
    this.elicitation.hide()
    this.syncFooter()
  }

  startSession(
    title: string | undefined,
    cwd: string,
    model: string,
    thinking: ThinkingEffort | undefined,
    mode: PermissionMode,
  ): void {
    this.cwd = redactText(cwd)
    this.palette.setWorkingDirectory(cwd)
    this.composer.refreshCompletion()
    this.setSessionTitle(title)
    this.statusBar.setModel(model)
    this.statusBar.setThinking(thinking)
    this.statusBar.setMode(mode)
    this.statusBar.resetUsage()
    this.statusBar.resetTurnElapsed()
    this.taskList.set([])
    if (!this.tasks.closeViewer()) this.viewJob(undefined)
    this.scrollback.clear()
    this.scrollback.appendHeader({ kind: "banner", model, cwd: compactPath(cwd) })
  }

  setSessionTitle(title: string | undefined): void {
    this.sessionTitle = title === undefined ? undefined : redactText(title)
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  setWorkingDirectory(cwd: string): void {
    this.cwd = redactText(cwd)
    this.palette.setWorkingDirectory(cwd)
    this.composer.refreshCompletion()
    this.renderer.setTerminalTitle(sessionTerminalTitle(this.sessionTitle, this.cwd))
  }

  async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
    this.config.hide()
    const options = request.options.map((option) => ({
      ...option,
      label: redactText(option.label),
      detail: redactText(option.detail),
      ...(option.note === undefined ? {} : { note: redactText(option.note) }),
    }))
    const chosen = this.picker.show(options, request.search ? redactText(request.search) : undefined)
    this.syncFooter()
    const index = await chosen
    return index === undefined ? undefined : options[index]?.value
  }

  async ask(question: string): Promise<string | undefined> {
    this.config.hide()
    this.picker.hide()
    return this.secret.show(redactText(question), false)
  }

  async askSecret(question: string): Promise<string | undefined> {
    this.config.hide()
    this.picker.hide()
    const value = await this.secret.show(redactText(question))
    if (value !== undefined) protectSecretValue(value)
    return value
  }

  openHistory(): void {
    this.palette.dismiss()
    this.executeCommand("/history")
    this.syncFooter()
  }

  openConfig(): void {
    this.picker.hide()
    this.config.show()
    this.syncFooter()
  }

  openAgents(): void {
    if (this.tasks.count === 0) {
      this.scrollback.append({ kind: "info", text: "No background work." })
      return
    }
    this.palette.dismiss()
    this.composer.blur()
    this.tasks.focus()
    this.syncFooter()
  }

  private elicitationAvailableHeight(): number {
    const siblingRows = this.jobViewer.visible
      ? STATUS_ROWS + this.tasks.height
      : this.live.height + this.queued.height + this.taskList.height + STATUS_ROWS + this.tasks.height
    return Math.max(1, this.renderer.terminalHeight - siblingRows)
  }

  syncFooter(): void {
    const overlaid = this.overlayVisible
    const jobPage = this.page.kind === "job"
    this.shortcutHelp.setCovered(overlaid || jobPage)
    if (jobPage) {
      this.palette.dismiss()
      this.reserved = 0
      this.composer.setVisible(false)
      this.composer.blur()
      this.statusBar.view.visible = false
      this.tasks.view.visible = false
      this.jobViewer.resize(this.renderer.terminalHeight)
      return
    }
    this.statusBar.view.visible = true
    this.tasks.view.visible = true
    if (overlaid !== this.overlaid) {
      this.overlaid = overlaid
      this.composer.setVisible(!overlaid)
      if (overlaid) {
        this.tasks.blur()
        this.composer.blur()
        this.elicitation.focus()
        this.picker.focus()
      } else {
        this.elicitation.blur()
        this.picker.blur()
        this.composer.focus()
      }
    } else {
      this.composer.setVisible(!overlaid)
    }
    if (overlaid) this.palette.dismiss()
    this.statusBar.setHint(this.palette.visible ? "↑↓ · Tab · Enter · Esc" : undefined)
    this.elicitation.fit()
    const overlayRows = this.permission.visible
      ? this.permission.height
      : this.elicitation.visible
        ? this.elicitation.height
        : this.secret.visible
          ? this.secret.height
          : this.picker.visible
            ? this.picker.height
            : this.config.height
    const paletteRows = this.palette.visible ? this.palette.height : 0
    if (this.paletteBelow || overlaid) this.reserved = 0
    else this.reserved = Math.max(this.reserved, paletteRows)
    const editing = this.composer.rows + this.shortcutHelp.height + Math.max(paletteRows, this.reserved)
    this.live.setGrouped(this.scrollback.endsWithTool)
    const contentRows =
      this.live.height +
      this.queued.height +
      this.taskList.height +
      (overlaid ? overlayRows : editing) +
      STATUS_ROWS +
      this.tasks.height
    this.renderer.footerHeight = mainFooterHeight(
      this.renderer.terminalHeight,
      this.scrollback.rows + this.pendingScrollbackRows,
      contentRows,
      this.live.height,
    )
  }

  private reclaim(rows: number): void {
    this.reserved = Math.max(0, this.reserved - rows)
    this.pendingScrollbackRows += rows
    try {
      this.syncFooter()
    } finally {
      this.pendingScrollbackRows -= rows
    }
  }

  private closedFooterRows(): number {
    if (this.jobViewer.visible) {
      return this.jobViewer.height + this.composer.rows + this.shortcutHelp.height + STATUS_ROWS + this.tasks.height
    }
    return (
      this.live.height +
      this.queued.height +
      this.taskList.height +
      this.composer.rows +
      this.shortcutHelp.height +
      STATUS_ROWS +
      this.tasks.height
    )
  }

  private spaceBelowFooter(): number {
    const terminal = this.renderer.terminalHeight
    const footer = this.closedFooterRows()
    const content = this.scrollback.rows + SCROLLBACK_GAP_ROWS
    const top = Math.max(0, Math.min(content, terminal - footer))
    return Math.max(0, terminal - top - footer)
  }

  private paletteLimit(): number {
    const space = this.paletteBelow
      ? this.spaceBelowFooter()
      : Math.max(0, this.renderer.terminalHeight - this.closedFooterRows())
    return space - PALETTE_CHROME_ROWS
  }

  private placePalette(): void {
    if (this.jobViewer.visible) return
    const below = this.spaceBelowFooter() > PALETTE_CHROME_ROWS
    if (below === this.paletteBelow) return
    this.paletteBelow = below
    this.view.remove(this.palette.view)
    this.view.insertBefore(this.palette.view, below ? this.statusBar.view : this.composer.view)
    this.syncFooter()
  }

  private commandContext(): CommandContext {
    return {
      session: this.session,
      print: (text) => this.scrollback.append({ kind: "info", text }),
      busy: (label) => this.statusBar.setLoading(label),
      select: <T>(request: SelectRequest<T>) => this.select(request),
      restore: (input) => this.composer.restore([input]),
      ask: (question) => this.ask(question),
      askSecret: (question) => this.askSecret(question),
    }
  }

  private runCommand(line: string): void {
    this.palette.dismiss()
    this.composer.setValue("")
    this.executeCommand(line)
    this.syncFooter()
  }

  private executeCommand(line: string): void {
    runCommand(line, this.commandContext()).catch((error: unknown) => {
      this.statusBar.setLoading(undefined)
      this.scrollback.append({ kind: "error", text: describeError(error) })
    })
  }

  private viewJob(task: BackgroundTask | undefined): void {
    if (task) {
      const entering = this.page.kind === "main"
      this.page = { kind: "job" }
      this.jobViewer.show(task)
      this.mainPanel.visible = false
      this.palette.dismiss()
      if (entering) {
        this.scrollback.setActive(false)
        this.renderer.externalOutputMode = "passthrough"
        this.renderer.screenMode = "alternate-screen"
      }
      this.syncFooter()
      return
    }
    if (this.page.kind === "main") return
    this.page = { kind: "main" }
    this.jobViewer.hide()
    this.mainPanel.visible = true
    this.syncFooter()
    this.renderer.screenMode = "split-footer"
    this.renderer.externalOutputMode = "capture-stdout"
    this.scrollback.setActive(true)
  }
}
