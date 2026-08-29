import { RenderableEvents, type BoxRenderable, type CliRenderer, type RGBA } from "@opentui/core"
import type { AgentSession } from "../../agent/session/session"
import {
  listBackgroundTasks,
  subscribeBackgroundTasks,
  type BackgroundAgentTask,
  type BackgroundTask,
} from "../../background/registry"
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
import { ChildEventController } from "./controllers/child-events"
import { column } from "./lib/renderables"
import { agentSnapshotMetrics } from "./lib/agent-metrics"
import { truncateToWidth } from "./lib/text"
import { COLORS } from "./theme/colors"
import type { MessageHistory } from "./message-history"
import { Scrollback } from "./scrollback/scrollback"
import type { ResolvedShortcuts } from "./shortcuts"
import { sessionTerminalTitle } from "./terminal"

export interface ScreenActions extends PermissionPopoverActions, ElicitationPopoverActions {
  submit(input: UserInput): boolean
}

const SCROLLBACK_GAP_ROWS = 1

type ScreenPage = { kind: "main" } | { kind: "agent"; taskId: string } | { kind: "job" }

interface ChildStore {
  task: BackgroundAgentTask
  scrollback: Scrollback
  statusBar: StatusBar
  detach: () => void
}

export function mainFooterHeight(
  terminalHeight: number,
  scrollbackRows: number,
  contentRows: number,
  liveRows: number,
): number {
  if (liveRows === 0) return contentRows
  return Math.max(contentRows, terminalHeight - scrollbackRows)
}

export function agentSteerDecision(
  steerable: boolean,
  input: UserInput,
): { kind: "error"; message: string } | { kind: "bounce" } | { kind: "send" } {
  if (input.images.length > 0) {
    return { kind: "error", message: "image input is not available while steering a task agent" }
  }
  if (!steerable) return { kind: "bounce" }
  return { kind: "send" }
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
  readonly agentComposer: Composer
  readonly statusBar: StatusBar
  readonly tasks: BackgroundTasks
  readonly taskList: TaskList
  private readonly shortcutHelp: ShortcutHelp
  private readonly childStores = new Map<string, ChildStore>()
  private readonly preferences: TuiConfig
  private readonly shortcuts: ResolvedShortcuts
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
    this.preferences = preferences
    this.shortcuts = shortcuts
    this.cwd = redactText(session.currentWorkingDirectory)
    this.scrollback = new Scrollback(
      renderer,
      startRow,
      (rows) => this.reclaim(rows),
      preferences,
      shortcuts.help("display.toggle-details"),
    )
    this.view = column(renderer, { width: "100%", height: "100%" })
    this.jobViewer = new JobViewer(renderer)
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
        completeCommand: (line) => this.activeComposer.setValue(line),
        completeSkill: (query, name, trailingSpace) => this.activeComposer.completeSkill(query, name, trailingSpace),
        completeFile: (query, path) => this.activeComposer.completeFile(query, path),
        runCommand: (line) => {
          if (this.page.kind === "agent") {
            this.rejectAgentCommand()
            return
          }
          this.runCommand(line)
        },
        error: (message) => this.activeScrollback.append({ kind: "error", text: message }),
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
    this.agentComposer = new Composer(
      renderer,
      history,
      {
        submit: (input) => this.submitAgentSteer(input),
        run: () => this.rejectAgentCommand(),
        error: (message) => this.appendAgentSteerError(message),
        change: (value, cursor) => {
          if (value.trimStart().startsWith("/")) {
            this.palette.dismiss()
            return
          }
          this.placePalette()
          this.palette.update(value, cursor, this.paletteLimit())
        },
        resize: () => this.syncFooter(),
      },
      COLORS.agent,
    )
    this.tasks = new BackgroundTasks(
      renderer,
      {
        changed: () => {
          this.jobViewer.refresh()
          this.refreshActiveAgentStatusBar()
          this.syncFooter()
        },
        released: () => {
          if (!this.overlayVisible) this.activeComposer.focus()
        },
        viewJob: (task) => this.viewJob(task),
        scrollViewer: (name) => this.page.kind === "job" && this.jobViewer.scrollKey(name),
        error: (message) => this.scrollback.append({ kind: "error", text: message }),
      },
      shortcuts.help("agents.stop-all"),
      () => this.session.id,
    )
    const unsubscribeChildStores = subscribeBackgroundTasks(() => this.syncChildStores())
    this.view.on(RenderableEvents.DESTROYED, unsubscribeChildStores)

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
    this.view.add(this.agentComposer.view)
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

  get agentPageOpen(): boolean {
    return this.page.kind === "agent"
  }

  get activeScrollback(): Scrollback {
    if (this.page.kind === "agent") return this.childStores.get(this.page.taskId)?.scrollback ?? this.scrollback
    return this.scrollback
  }

  get activeComposer(): Composer {
    if (this.page.kind === "agent") return this.agentComposer
    return this.composer
  }

  get activeStatusBar(): StatusBar {
    if (this.page.kind === "agent") return this.childStores.get(this.page.taskId)?.statusBar ?? this.statusBar
    return this.statusBar
  }

  setTerminalBackground(background: RGBA): boolean {
    let changed = this.scrollback.setTerminalBackground(background)
    for (const store of this.childStores.values()) {
      changed = store.scrollback.setTerminalBackground(background) || changed
    }
    return changed
  }

  replayActiveTranscript(): void {
    this.activeScrollback.replay()
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
    this.tasks.closeViewer()
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
    this.tasks.closeViewer()
    this.config.hide()
    this.picker.hide()
    return this.secret.show(redactText(question), false)
  }

  async askSecret(question: string): Promise<string | undefined> {
    this.tasks.closeViewer()
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
    if (this.page.kind === "agent") {
      this.shortcutHelp.setCovered(true)
      this.composer.setVisible(false)
      this.composer.blur()
      this.agentComposer.setVisible(true)
      this.statusBar.view.visible = false
      this.showAgentStatusBar(this.page.taskId)
      this.tasks.view.visible = true
      const paletteRows = this.palette.visible ? this.palette.height : 0
      if (this.paletteBelow) this.reserved = 0
      else this.reserved = Math.max(this.reserved, paletteRows)
      const editing = this.agentComposer.rows + this.shortcutHelp.height + Math.max(paletteRows, this.reserved)
      const contentRows = editing + STATUS_ROWS + this.tasks.height
      this.renderer.footerHeight = mainFooterHeight(
        this.renderer.terminalHeight,
        this.activeScrollback.rows + this.pendingScrollbackRows,
        contentRows,
        0,
      )
      this.activeStatusBar.setHint(this.palette.visible ? "↑↓ · Tab · Enter · Esc" : undefined)
      return
    }
    const jobPage = this.page.kind === "job"
    this.shortcutHelp.setCovered(overlaid || jobPage)
    if (jobPage) {
      this.palette.dismiss()
      this.reserved = 0
      this.composer.setVisible(false)
      this.composer.blur()
      this.agentComposer.setVisible(false)
      this.statusBar.view.visible = false
      this.showAgentStatusBar(undefined)
      this.tasks.view.visible = false
      this.jobViewer.resize(this.renderer.terminalHeight)
      return
    }
    this.statusBar.view.visible = true
    this.showAgentStatusBar(undefined)
    this.agentComposer.setVisible(false)
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
    this.activeStatusBar.setHint(this.palette.visible ? "↑↓ · Tab · Enter · Esc" : undefined)
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
    if (this.page.kind === "agent") {
      return this.agentComposer.rows + this.shortcutHelp.height + STATUS_ROWS + this.tasks.height
    }
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
    const content = this.activeScrollback.rows + SCROLLBACK_GAP_ROWS
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
    this.view.insertBefore(this.palette.view, below ? this.activeStatusBar.view : this.activeComposer.view)
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
    if (task === undefined) {
      this.openMainPage()
      return
    }
    if (task.kind === "agent") {
      this.openAgentPage(task)
      return
    }
    this.openJobPage(task)
  }

  private openMainPage(): void {
    switch (this.page.kind) {
      case "main":
        return
      case "agent": {
        const store = this.childStores.get(this.page.taskId)
        this.page = { kind: "main" }
        this.palette.dismiss()
        store?.scrollback.setActive(false)
        this.scrollback.setActive(true)
        this.mainPanel.visible = true
        this.agentComposer.setVisible(false)
        this.agentComposer.setBadge(undefined)
        this.agentComposer.blur()
        if (!this.tasks.focused) this.composer.focus()
        this.syncFooter()
        return
      }
      case "job":
        this.page = { kind: "main" }
        this.jobViewer.hide()
        this.mainPanel.visible = true
        this.syncFooter()
        this.renderer.screenMode = "split-footer"
        this.renderer.externalOutputMode = "capture-stdout"
        this.scrollback.setActive(true)
        return
    }
  }

  private openAgentPage(task: BackgroundAgentTask): void {
    const store = this.childStores.get(task.id)
    if (!store) return
    const previous = this.page
    if (previous.kind === "agent") {
      if (previous.taskId === task.id) return
      this.childStores.get(previous.taskId)?.scrollback.setActive(false)
    }
    if (previous.kind === "job") {
      this.jobViewer.hide()
      this.renderer.screenMode = "split-footer"
      this.renderer.externalOutputMode = "capture-stdout"
    } else {
      this.scrollback.setActive(false)
    }
    this.page = { kind: "agent", taskId: task.id }
    this.palette.dismiss()
    this.mainPanel.visible = false
    this.agentComposer.setBadge(` ${truncateToWidth(redactText(task.id), 24)}`)
    store.scrollback.setActive(true)
    this.seedAgentStatusBar(store)
    this.syncFooter()
    this.tasks.blur()
    this.agentComposer.focus()
  }

  private openJobPage(task: Exclude<BackgroundTask, BackgroundAgentTask>): void {
    const previous = this.page
    this.page = { kind: "job" }
    if (previous.kind === "agent") {
      this.palette.dismiss()
      this.childStores.get(previous.taskId)?.scrollback.setActive(false)
      this.agentComposer.setVisible(false)
      this.agentComposer.blur()
    }
    this.jobViewer.show(task)
    this.mainPanel.visible = false
    this.palette.dismiss()
    if (previous.kind !== "job") {
      this.scrollback.setActive(false)
      this.renderer.externalOutputMode = "passthrough"
      this.renderer.screenMode = "alternate-screen"
    }
    this.syncFooter()
  }

  private activeChildStore(): ChildStore | undefined {
    if (this.page.kind !== "agent") return undefined
    return this.childStores.get(this.page.taskId)
  }

  private submitAgentSteer(input: UserInput): boolean {
    const store = this.activeChildStore()
    if (!store) return false
    const steerable = store.task.state().running && store.task.childSessionId() !== undefined
    const decision = agentSteerDecision(steerable, input)
    if (decision.kind === "error") {
      this.appendAgentSteerError(decision.message)
      return false
    }
    if (decision.kind === "bounce" || !store.task.send(input.text)) {
      this.activeStatusBar.flashNotice(`${store.task.id} is not accepting input`)
      return false
    }
    return true
  }

  private rejectAgentCommand(): void {
    this.appendAgentSteerError("commands are not available while steering a task agent")
  }

  private appendAgentSteerError(message: string): void {
    this.activeScrollback.append({ kind: "error", text: message })
  }

  private showAgentStatusBar(taskId: string | undefined): void {
    for (const [id, store] of this.childStores) {
      store.statusBar.view.visible = id === taskId
    }
  }

  private seedAgentStatusBar(store: ChildStore): void {
    store.statusBar.setModel(store.task.model)
    store.statusBar.setMode(store.task.mode)
    store.statusBar.setMetrics(agentSnapshotMetrics(store.task.state(), store.task.snapshot()))
  }

  private refreshActiveAgentStatusBar(): void {
    if (this.page.kind !== "agent") return
    const store = this.childStores.get(this.page.taskId)
    if (store) this.seedAgentStatusBar(store)
  }

  private syncChildStores(): void {
    const agents = listBackgroundTasks().filter((task): task is BackgroundAgentTask => task.kind === "agent")
    for (const task of agents) {
      if (this.childStores.has(task.id)) continue
      this.childStores.set(task.id, this.createChildStore(task))
    }
    for (const id of [...this.childStores.keys()]) {
      if (agents.some((task) => task.id === id)) continue
      this.disposeChildStore(id)
    }
  }

  private createChildStore(task: BackgroundAgentTask): ChildStore {
    const scrollback = new Scrollback(
      this.renderer,
      0,
      (rows) => this.reclaim(rows),
      this.preferences,
      this.shortcuts.help("display.toggle-details"),
    )
    scrollback.setActive(false)
    const statusBar = new StatusBar(this.renderer, task.model, undefined, task.mode)
    statusBar.view.visible = false
    this.view.insertBefore(statusBar.view, this.tasks.view)
    const controller = new ChildEventController(scrollback, statusBar)
    return {
      task,
      scrollback,
      statusBar,
      detach: task.onEvent === undefined ? () => {} : task.onEvent((event) => controller.handle(event)),
    }
  }

  private disposeChildStore(id: string): void {
    const store = this.childStores.get(id)
    if (!store) return
    if (this.page.kind === "agent" && this.page.taskId === id) this.openMainPage()
    this.childStores.delete(id)
    store.scrollback.setActive(false)
    store.detach()
    this.view.remove(store.statusBar.view)
    store.statusBar.view.destroyRecursively()
  }
}
