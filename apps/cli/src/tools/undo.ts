import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { describeError } from "../lib/error"
import {
  createNativeGitRepository,
  type NativeGitRepository,
  type NativeGitSnapshot,
  type NativeGitlink,
} from "../native"

export interface UndoPreview {
  messageId: string
  prompt: string
  paths: string[]
  codeAvailable: boolean
  unavailable?: string
}

type Snapshot = NativeGitSnapshot

interface PromptCheckpoint {
  messageId: string
  prompt: string
  snapshot: number
  available: boolean
  unavailable?: string
}

interface BusyState {
  kind: "capture" | "rewind" | "redo"
  token: symbol
}

interface RewindTransaction {
  snapshots: Snapshot[]
  checkpoints: PromptCheckpoint[]
  snapshotPosition: number
  checkpointPosition: number
  branch: number
  token: symbol
}

interface RedoTransaction {
  snapshots: Snapshot[]
  checkpoints: PromptCheckpoint[]
  snapshotPosition: number
  checkpointPosition: number
  branch: number
}

type RepositoryDiscovery = { status: "ready"; repository: Repository } | { status: "unavailable"; reason: string }

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function canonicalTarget(path: string): string {
  let current = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(current), ...suffix.toReversed())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.push(basename(current))
      current = parent
    }
  }
}

function pathIsInside(base: string, target: string): boolean {
  const path = relative(base, target)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

function gitPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

async function applyAtomically(
  snapshots: Snapshot[],
  apply: (snapshot: Snapshot) => Promise<void>,
  rollback: (snapshot: Snapshot) => Promise<void>,
  rollbackMessage: string,
): Promise<void> {
  const applied: Snapshot[] = []
  for (const snapshot of snapshots) {
    try {
      await apply(snapshot)
      applied.push(snapshot)
    } catch (error) {
      try {
        for (const completed of applied.toReversed()) await rollback(completed)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${describeError(error)}; ${rollbackMessage}: ${describeError(rollbackError)}`,
          { cause: rollbackError },
        )
      }
      throw error
    }
  }
}

class Repository {
  private constructor(private readonly native: NativeGitRepository) {}

  static async discover(workspace: string): Promise<RepositoryDiscovery> {
    const native = createNativeGitRepository(workspace)
    try {
      const discovery = await native.discover()
      if (discovery.status === "unavailable") return discovery
      return { status: "ready", repository: new Repository(native) }
    } catch (error) {
      return { status: "unavailable", reason: describeError(error) }
    }
  }

  captureTargeted(forced: string[]): Promise<string> {
    return this.native.capture({ forced, full: false })
  }

  captureWorkspace(): Promise<string> {
    return this.native.capture({ forced: [], full: true })
  }

  changedPaths(before: string, after: string): Promise<string[]> {
    return this.native.changedPaths({ before, after })
  }

  indexState(paths: string[]): Promise<Uint8Array> {
    return this.native.indexState(paths)
  }

  headState(): Promise<string> {
    return this.native.headState()
  }

  gitlinks(before: string, after: string, paths: string[]): Promise<NativeGitlink[]> {
    return this.native.gitlinks({ before, after, paths })
  }

  restore(snapshot: Snapshot): Promise<void> {
    return this.native.applySnapshot({ snapshot, reverse: true })
  }

  reapply(snapshot: Snapshot): Promise<void> {
    return this.native.applySnapshot({ snapshot, reverse: false })
  }
}

class UndoCore {
  private readonly repository: Promise<RepositoryDiscovery>
  private readonly snapshots: Snapshot[] = []
  private checkpoints: PromptCheckpoint[] = []
  private branchValue = 0
  private epoch = 0
  private busy: BusyState | undefined
  private captureTail: Promise<void> = Promise.resolve()
  private pendingCaptures = 0

  constructor(
    private readonly workspace: string,
    private readonly requestedWorkspace: string,
  ) {
    this.repository = Repository.discover(workspace)
  }

  get branch(): number {
    return this.branchValue
  }

  seed(prompts: Array<{ messageId: string; prompt: string }>): void {
    this.assertPromptMutationAvailable()
    const snapshot = this.snapshots.length
    this.incrementBranch()
    this.checkpoints = prompts.map(({ messageId, prompt }) => ({
      messageId,
      prompt,
      snapshot,
      available: false,
      unavailable: "code before this process resumed was not captured",
    }))
  }

  markPrompt(messageId: string, prompt: string): void {
    this.assertPromptMutationAvailable()
    this.appendPrompt(messageId, prompt)
  }

  markPromptAfterCaptures(messageId: string, prompt: string): Promise<void> {
    return this.withCaptureTurn(async () => {
      if (this.busy) throw new Error("a prompt checkpoint cannot be changed while code undo is running")
      this.appendPrompt(messageId, prompt)
    })
  }

  private appendPrompt(messageId: string, prompt: string): void {
    this.incrementBranch()
    this.checkpoints.push({
      messageId,
      prompt,
      snapshot: this.snapshots.length,
      available: true,
    })
  }

  async previews(): Promise<UndoPreview[]> {
    const discovery = await this.repository
    return this.checkpoints.map((checkpoint) => {
      if (!checkpoint.available) {
        return {
          messageId: checkpoint.messageId,
          prompt: checkpoint.prompt,
          paths: [],
          codeAvailable: false,
          ...(checkpoint.unavailable ? { unavailable: checkpoint.unavailable } : {}),
        }
      }
      if (discovery.status === "unavailable") {
        return {
          messageId: checkpoint.messageId,
          prompt: checkpoint.prompt,
          paths: [],
          codeAvailable: false,
          unavailable: discovery.reason,
        }
      }
      if (checkpoint.snapshot > this.snapshots.length) throw new Error("undo checkpoint state is inconsistent")
      const paths = new Set<string>()
      for (const snapshot of this.snapshots.slice(checkpoint.snapshot)) {
        for (const path of snapshot.paths) paths.add(path)
      }
      return {
        messageId: checkpoint.messageId,
        prompt: checkpoint.prompt,
        paths: [...paths].sort(),
        codeAvailable: true,
      }
    })
  }

  async trackPaths<T>(tool: string, paths: string[], operation: () => Promise<T>): Promise<T> {
    const discovery = await this.repository
    if (discovery.status === "unavailable" || paths.length === 0) return operation()

    const forced = this.relativeTargets(paths)
    if (!forced) {
      this.invalidateCode(`${tool} targeted a path outside the workspace, so full undo is unavailable`)
      return operation()
    }
    if (forced.length === 0) return operation()

    return this.trackCapture(
      tool,
      discovery.repository,
      forced,
      () => discovery.repository.captureTargeted(forced),
      false,
      operation,
    )
  }

  async trackWorkspace<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    const discovery = await this.repository
    if (discovery.status === "unavailable") return operation()
    return this.trackCapture(
      tool,
      discovery.repository,
      [],
      () => discovery.repository.captureWorkspace(),
      true,
      operation,
    )
  }

  private trackCapture<T>(
    tool: string,
    repository: Repository,
    forced: string[],
    capture: () => Promise<string>,
    watchIndex: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withCaptureTurn(async () => {
      const token = Symbol("capture")
      try {
        this.acquireBusy("capture", token)
      } catch (error) {
        throw new Error(`Git snapshot failed; ${tool} was not run: ${describeError(error)}`, { cause: error })
      }
      const epoch = this.epoch
      let before: string
      let beforeIndex: Uint8Array | undefined
      let beforeHead: string | undefined
      try {
        before = await capture()
        if (watchIndex) {
          beforeIndex = await repository.indexState([])
          beforeHead = await repository.headState()
        }
      } catch (error) {
        this.releaseBusy(token, "capture")
        throw new Error(`Git snapshot failed; ${tool} was not run: ${describeError(error)}`, { cause: error })
      }

      let outcome: { status: "completed"; value: T } | { status: "failed"; error: unknown }
      try {
        outcome = { status: "completed", value: await operation() }
      } catch (error) {
        outcome = { status: "failed", error }
      }

      let finishError: unknown
      try {
        if (this.epoch === epoch) {
          const after = await capture()
          const afterIndex = watchIndex ? await repository.indexState([]) : undefined
          const afterHead = watchIndex ? await repository.headState() : undefined
          if (beforeHead !== undefined && afterHead !== undefined && beforeHead !== afterHead) {
            this.invalidateCode("Git HEAD changed during a shell command, so full undo is unavailable")
          } else if (beforeIndex && afterIndex && !bytesEqual(beforeIndex, afterIndex)) {
            this.invalidateCode("the Git index changed during a shell command, so full undo is unavailable")
          } else {
            const changed = await repository.changedPaths(before, after)
            const index = await repository.indexState(changed)
            const gitlinks = await repository.gitlinks(before, after, changed)
            if (this.epoch === epoch && changed.length > 0) {
              this.snapshots.push({ before, after, paths: changed, index, gitlinks, forced })
              this.incrementBranch()
            }
          }
        }
      } catch (error) {
        finishError = error
      } finally {
        this.releaseBusy(token, "capture")
      }

      if (this.epoch !== epoch) finishError = undefined
      if (finishError !== undefined) {
        this.invalidateCode(`${tool} changes could not be captured, so full undo is unavailable`)
      }
      if (outcome.status === "failed") {
        if (finishError !== undefined) {
          throw new AggregateError(
            [outcome.error, finishError],
            `${tool} failed, and its undo snapshot could not be recorded: ${describeError(finishError)}`,
          )
        }
        throw outcome.error
      }
      if (finishError !== undefined) {
        throw new Error(
          `${tool} completed, but its undo snapshot could not be recorded: ${describeError(finishError)}`,
          {
            cause: finishError,
          },
        )
      }
      return outcome.value
    })
  }

  async trackInvalidation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy && this.busy.kind !== "capture") {
      throw new Error("workspace invalidation is unavailable while code undo or redo is being applied")
    }
    this.invalidateCode("background shell changes cannot be captured, so full undo is unavailable")
    return operation()
  }

  async rewind(messageId: string): Promise<CodeRewind> {
    const discovery = await this.repository
    if (discovery.status === "unavailable") {
      throw new Error(`code undo requires a Git repository: ${discovery.reason}`)
    }
    if (this.busy || this.pendingCaptures > 0) {
      throw new Error("undo is unavailable while agent tools are running")
    }
    const checkpointPosition = this.checkpoints.findIndex((checkpoint) => checkpoint.messageId === messageId)
    if (checkpointPosition < 0) throw new Error("code for that checkpoint is no longer available")
    const checkpoint = this.checkpoints[checkpointPosition]
    if (!checkpoint) throw new Error("code for that checkpoint is no longer available")
    if (!checkpoint.available) {
      throw new Error(checkpoint.unavailable ?? "code for that checkpoint is no longer available")
    }
    if (checkpoint.snapshot > this.snapshots.length) throw new Error("code for that checkpoint is stale")

    const snapshots = this.snapshots.slice(checkpoint.snapshot)
    const checkpoints = this.checkpoints.slice(checkpointPosition)
    const token = Symbol("rewind")
    this.acquireBusy("rewind", token)
    try {
      await applyAtomically(
        snapshots.toReversed(),
        (snapshot) => discovery.repository.restore(snapshot),
        (snapshot) => discovery.repository.reapply(snapshot),
        "restoring the pre-undo worktree also failed",
      )
    } catch (error) {
      this.releaseBusy(token, "rewind")
      throw error
    }

    this.snapshots.length = checkpoint.snapshot
    this.checkpoints.length = checkpointPosition
    return new CodeRewind(this, {
      snapshots,
      checkpoints,
      snapshotPosition: checkpoint.snapshot,
      checkpointPosition,
      branch: this.branchValue,
      token,
    })
  }

  commitRewind(transaction: RewindTransaction): CodeRedo[] {
    this.assertTransaction(transaction.token, "rewind")
    this.assertRewoundPosition(transaction)
    const redos = transaction.checkpoints.map((checkpoint, index) => {
      const start = checkpoint.snapshot - transaction.snapshotPosition
      const end =
        (transaction.checkpoints[index + 1]?.snapshot ?? transaction.snapshotPosition + transaction.snapshots.length) -
        transaction.snapshotPosition
      return new CodeRedo(this, {
        snapshots: transaction.snapshots.slice(start, end),
        checkpoints: [checkpoint],
        snapshotPosition: checkpoint.snapshot,
        checkpointPosition: transaction.checkpointPosition + index,
        branch: transaction.branch,
      })
    })
    this.releaseBusy(transaction.token, "rewind")
    return redos
  }

  async rollbackRewind(transaction: RewindTransaction): Promise<void> {
    this.assertTransaction(transaction.token, "rewind")
    this.assertRewoundPosition(transaction)
    const discovery = await this.readyRepository()
    try {
      await applyAtomically(
        transaction.snapshots,
        (snapshot) => discovery.reapply(snapshot),
        (snapshot) => discovery.restore(snapshot),
        "restoring the rewound worktree also failed",
      )
      this.snapshots.push(...transaction.snapshots)
      this.checkpoints.push(...transaction.checkpoints)
    } finally {
      this.releaseBusy(transaction.token, "rewind")
    }
  }

  async applyRedo(transaction: RedoTransaction): Promise<AppliedCodeRedo> {
    const discovery = await this.readyRepository()
    if (this.busy || this.pendingCaptures > 0) {
      throw new Error("redo is unavailable while agent tools are running")
    }
    if (this.branchValue !== transaction.branch || this.snapshots.length !== transaction.snapshotPosition) {
      throw new Error("a new prompt or agent change created a divergent branch")
    }
    const token = Symbol("redo")
    this.acquireBusy("redo", token)
    try {
      await applyAtomically(
        transaction.snapshots,
        (snapshot) => discovery.reapply(snapshot),
        (snapshot) => discovery.restore(snapshot),
        "restoring the undone worktree also failed",
      )
    } catch (error) {
      this.releaseBusy(token, "redo")
      throw error
    }
    return new AppliedCodeRedo(this, transaction, token)
  }

  commitRedo(transaction: RedoTransaction, token: symbol): void {
    this.assertTransaction(token, "redo")
    this.assertRedoPosition(transaction)
    this.snapshots.push(...transaction.snapshots)
    this.checkpoints.push(...transaction.checkpoints)
    this.releaseBusy(token, "redo")
  }

  async rollbackRedo(transaction: RedoTransaction, token: symbol): Promise<void> {
    this.assertTransaction(token, "redo")
    this.assertRedoPosition(transaction)
    const discovery = await this.readyRepository()
    try {
      await applyAtomically(
        transaction.snapshots.toReversed(),
        (snapshot) => discovery.restore(snapshot),
        (snapshot) => discovery.reapply(snapshot),
        "restoring the redone worktree also failed",
      )
    } finally {
      this.releaseBusy(token, "redo")
    }
  }

  private relativeTargets(paths: string[]): string[] | undefined {
    const targets = new Set<string>()
    for (const path of paths) {
      if (!path) return undefined
      let absolute = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path)
      if (!pathIsInside(this.workspace, absolute) && pathIsInside(this.requestedWorkspace, absolute)) {
        absolute = resolve(this.workspace, relative(this.requestedWorkspace, absolute))
      }
      if (!pathIsInside(this.workspace, absolute)) return undefined
      absolute = canonicalTarget(absolute)
      if (!pathIsInside(this.workspace, absolute)) return undefined
      const target = relative(this.workspace, absolute)
      if (!target) return undefined
      targets.add(gitPath(target))
    }
    return [...targets].sort()
  }

  private withCaptureTurn<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingCaptures++
    const previous = this.captureTail
    let release = (): void => {
      throw new Error("capture queue was not initialized")
    }
    this.captureTail = new Promise<void>((resolveTurn) => {
      release = () => resolveTurn()
    })
    return previous.then(async () => {
      try {
        return await operation()
      } finally {
        this.pendingCaptures--
        release()
      }
    })
  }

  private acquireBusy(kind: BusyState["kind"], token: symbol): void {
    if (this.busy) throw new Error("another Git snapshot is already in progress")
    this.busy = { kind, token }
  }

  private releaseBusy(token: symbol, kind: BusyState["kind"]): void {
    this.assertTransaction(token, kind)
    this.busy = undefined
  }

  private assertTransaction(token: symbol, kind: BusyState["kind"]): void {
    if (this.busy?.token === token && this.busy.kind === kind) return
    throw new Error(`code ${kind} transaction is no longer active`)
  }

  private assertPromptMutationAvailable(): void {
    if (!this.busy && this.pendingCaptures === 0) return
    throw new Error("a prompt checkpoint cannot be changed while an agent tool or code undo is running")
  }

  private assertRewoundPosition(transaction: RewindTransaction): void {
    if (
      this.snapshots.length === transaction.snapshotPosition &&
      this.checkpoints.length === transaction.checkpointPosition
    ) {
      return
    }
    throw new Error("the code rewind transaction is stale")
  }

  private assertRedoPosition(transaction: RedoTransaction): void {
    if (
      this.branchValue === transaction.branch &&
      this.snapshots.length === transaction.snapshotPosition &&
      this.checkpoints.length === transaction.checkpointPosition
    ) {
      return
    }
    throw new Error("a new prompt or agent change created a divergent branch")
  }

  private async readyRepository(): Promise<Repository> {
    const discovery = await this.repository
    if (discovery.status === "ready") return discovery.repository
    throw new Error(`code undo requires a Git repository: ${discovery.reason}`)
  }

  private incrementBranch(): void {
    this.branchValue = this.increment(this.branchValue)
  }

  private invalidateCode(reason: string): void {
    this.epoch = this.increment(this.epoch)
    this.incrementBranch()
    for (const checkpoint of this.checkpoints) {
      checkpoint.available = false
      checkpoint.unavailable = reason
    }
  }

  private increment(value: number): number {
    return value === Number.MAX_SAFE_INTEGER ? 0 : value + 1
  }
}

export class WorkspaceUndo {
  private readonly core: UndoCore

  constructor(cwd: string) {
    const requestedWorkspace = resolve(cwd)
    this.core = new UndoCore(canonicalPath(requestedWorkspace), requestedWorkspace)
  }

  get branch(): number {
    return this.core.branch
  }

  seed(prompts: Array<{ messageId: string; prompt: string }>): void {
    this.core.seed(prompts)
  }

  markPrompt(messageId: string, prompt: string): void {
    this.core.markPrompt(messageId, prompt)
  }

  markPromptAfterCaptures(messageId: string, prompt: string): Promise<void> {
    return this.core.markPromptAfterCaptures(messageId, prompt)
  }

  previews(): Promise<UndoPreview[]> {
    return this.core.previews()
  }

  trackPaths<T>(tool: string, paths: string[], operation: () => Promise<T>): Promise<T> {
    return this.core.trackPaths(tool, paths, operation)
  }

  trackWorkspace<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    return this.core.trackWorkspace(tool, operation)
  }

  trackInvalidation<T>(operation: () => Promise<T>): Promise<T> {
    return this.core.trackInvalidation(operation)
  }

  rewind(messageId: string): Promise<CodeRewind> {
    return this.core.rewind(messageId)
  }
}

export class CodeRewind {
  readonly count: number
  readonly steps: number
  private settled = false

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RewindTransaction,
  ) {
    this.count = new Set(transaction.snapshots.flatMap((snapshot) => snapshot.paths)).size
    this.steps = transaction.checkpoints.length
  }

  commit(): CodeRedo[] {
    if (this.settled) throw new Error("code rewind is no longer active")
    const redo = this.core.commitRewind(this.transaction)
    this.settled = true
    return redo
  }

  async rollback(): Promise<void> {
    if (this.settled) throw new Error("code rewind is no longer active")
    try {
      await this.core.rollbackRewind(this.transaction)
    } finally {
      this.settled = true
    }
  }
}

export class CodeRedo {
  readonly count: number

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RedoTransaction,
  ) {
    this.count = new Set(transaction.snapshots.flatMap((snapshot) => snapshot.paths)).size
  }

  apply(): Promise<AppliedCodeRedo> {
    return this.core.applyRedo(this.transaction)
  }
}

export class AppliedCodeRedo {
  private settled = false

  constructor(
    private readonly core: UndoCore,
    private readonly transaction: RedoTransaction,
    private readonly token: symbol,
  ) {}

  commit(): void {
    if (this.settled) throw new Error("applied code redo is no longer active")
    this.core.commitRedo(this.transaction, this.token)
    this.settled = true
  }

  async rollback(): Promise<void> {
    if (this.settled) throw new Error("applied code redo is no longer active")
    try {
      await this.core.rollbackRedo(this.transaction, this.token)
    } finally {
      this.settled = true
    }
  }
}
