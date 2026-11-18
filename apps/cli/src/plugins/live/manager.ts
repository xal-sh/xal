import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { agentHome, projectConfigPath } from "../../config/paths"
import type { PluginFailure } from "../../events"
import { describeError } from "../../lib/error"
import { readPluginDraft } from "../../native"
import { findProjectRoot } from "../../project/root"
import { isTrusted } from "../../project/trust"
import {
  clearRevocation,
  digest,
  MAX_PLUGIN_BYTES,
  notFound,
  readApproval,
  recordRevocation,
  revocationFile,
  revokedThrough,
  scopedPathExists,
  unchangedApproval,
  withApprovalLock,
  withPublicationLock,
  type ApprovalRevision,
  type ApprovalVersion,
} from "./approval"
import { installContributions, stageLivePlugin, type LiveContributions } from "./contributions"

export type PluginScope = "project" | "user"

interface ActivePlugin {
  scope: PluginScope
  sha256: string
  contributions: LiveContributions
  remove(): void
}

interface TrackedApproval extends ApprovalRevision {
  pending?: ApprovalVersion & { recorded: boolean }
}

function checkName(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error("expected a lower-case plugin name, up to 64 characters")
}

export class LivePlugins {
  private readonly active = new Map<string, ActivePlugin>()
  private readonly cleanupFailures = new Map<string, string>()
  private readonly tracked: Record<PluginScope, Map<string, TrackedApproval>> = { user: new Map(), project: new Map() }
  private readonly home = resolve(agentHome())
  readonly directories: Record<PluginScope, string>

  constructor(
    readonly root: string,
    readonly startupPlugins: () => string[],
  ) {
    this.directories = { user: join(this.home, "plugins"), project: join(dirname(projectConfigPath(root)), "plugins") }
  }

  list() {
    return [...this.active].map(([name, { scope, sha256, contributions }]) => ({
      name,
      scope,
      sha256,
      approvedFile: this.approvedFile(scope, name),
      tools: contributions.tools.map((tool) => tool.name),
      commands: contributions.commands.map((command) => command.name),
      renderers: contributions.renderers.map((renderer) => renderer.tool),
    }))
  }

  private store(scope: PluginScope): string {
    const base = join(this.home, "approved-plugins")
    return scope === "user" ? join(base, "user") : join(base, "projects", digest(this.root))
  }

  private approvedFile(scope: PluginScope, name: string): string {
    return join(this.store(scope), `${name}.json`)
  }

  private track(
    scope: PluginScope,
    name: string,
    { installation, generation, stamp }: ApprovalRevision,
  ): TrackedApproval {
    const entry = { installation, generation, stamp }
    this.tracked[scope].set(name, entry)
    return entry
  }

  private unload(scope: PluginScope, name: string): boolean {
    const plugin = this.active.get(name)
    if (plugin?.scope !== scope) return false
    plugin.remove()
    this.active.delete(name)
    return true
  }

  private hasFolder(scope: PluginScope, name: string): boolean {
    return scopedPathExists(
      scope === "project" ? this.root : this.home,
      join(this.directories[scope], name),
      "directory",
    )
  }

  private retire(
    scope: PluginScope,
    name: string,
    entry: TrackedApproval,
    version: ApprovalVersion,
    removed?: string[],
  ): void {
    this.unload(scope, name)
    if (entry.pending?.installation !== version.installation || entry.pending.generation < version.generation) {
      entry.pending = { installation: version.installation, generation: version.generation, recorded: false }
    }
    const pending = entry.pending
    if (pending.recorded) return
    const file = this.approvedFile(scope, name)
    try {
      recordRevocation(this.home, revocationFile(this.home, file, pending.installation), pending.generation)
    } catch (markerError) {
      try {
        const deleted = withApprovalLock(this.home, () => {
          const current = readApproval(this.home, file)
          if (current?.installation !== pending.installation || current.generation > pending.generation) return false
          unlinkSync(file)
          return true
        })
        if (!deleted) return
      } catch (unlinkError) {
        throw new Error(
          `Unloaded locally; other sessions may still restore this plugin. Will retry: ${describeError(markerError)}; ${describeError(unlinkError)}`,
          { cause: unlinkError },
        )
      }
    }
    pending.recorded = true
    removed?.push(`${scope}:${name}`)
  }

  private discardRevoked(
    scope: PluginScope,
    name: string,
    installation: string,
    current: ReturnType<typeof readApproval>,
    pendingGeneration = -1,
  ) {
    const file = this.approvedFile(scope, name)
    const marker = revocationFile(this.home, file, installation)
    if (current?.installation === installation) {
      if (current.generation > pendingGeneration && current.generation > revokedThrough(this.home, marker))
        return current
      this.unload(scope, name)
      unlinkSync(file)
      current = undefined
    }
    clearRevocation(this.home, marker)
    return current
  }

  private reconcile(scope: PluginScope, name: string, entry: TrackedApproval, removed?: string[]) {
    const file = this.approvedFile(scope, name)
    let missing: boolean | undefined
    let saved: ReturnType<typeof readApproval>
    try {
      if (scopedPathExists(this.home, file, "file")) {
        missing = !this.hasFolder(scope, name)
        if (
          !missing &&
          removed &&
          !entry.pending &&
          unchangedApproval(this.home, file, revocationFile(this.home, file, entry.installation), entry.stamp)
        )
          return
        saved = readApproval(this.home, file)
      }
    } catch (error) {
      if (missing ?? !this.hasFolder(scope, name)) {
        this.retire(
          scope,
          name,
          entry,
          { installation: entry.pending?.installation ?? entry.installation, generation: Number.MAX_SAFE_INTEGER },
          removed,
        )
      }
      throw error
    }
    let cutoff = -1
    if (saved && missing) this.retire(scope, name, entry, saved, removed)
    else if (
      entry.pending &&
      saved?.installation === entry.pending.installation &&
      saved.generation <= entry.pending.generation
    )
      this.retire(scope, name, entry, entry.pending, removed)
    else if (saved) {
      cutoff = revokedThrough(this.home, revocationFile(this.home, file, saved.installation))
      if (saved.generation <= cutoff) this.retire(scope, name, entry, saved, removed)
    }
    if (entry.pending) {
      const retired = entry.pending
      withApprovalLock(this.home, () => {
        const latest = readApproval(this.home, file)
        const current = this.discardRevoked(scope, name, retired.installation, latest, retired.generation)
        if (current) this.track(scope, name, current)
        else this.tracked[scope].delete(name)
      })
      return
    }
    if (saved?.installation !== entry.installation || entry.generation <= cutoff) {
      if (this.unload(scope, name)) removed?.push(`${scope}:${name}`)
      if (saved) this.track(scope, name, saved)
      else this.tracked[scope].delete(name)
    } else {
      entry.stamp = saved.stamp
    }
    return saved
  }

  async removeDeleted(canRemove: () => boolean) {
    const removed: string[] = []
    for (const scope of ["user", "project"] as const) {
      const entries = this.tracked[scope]
      if (!entries.size || !canRemove()) continue
      try {
        const trusted = scope === "user" || (await isTrusted(this.root))
        if (!trusted) continue
        this.cleanupFailures.delete(scope)
      } catch (error) {
        this.cleanupFailures.set(scope, describeError(error))
        continue
      }
      for (const [name, entry] of entries) {
        if (!canRemove()) break
        const key = `${scope}:${name}`
        try {
          await withPublicationLock(this.home, async () => {
            if (scope === "project" && !(await isTrusted(this.root))) return
            if (!canRemove() || entries.get(name) !== entry) return
            this.reconcile(scope, name, entry, removed)
            this.cleanupFailures.delete(key)
          })
        } catch (error) {
          this.cleanupFailures.set(key, describeError(error))
        }
      }
    }
    return { removed, failures: [...this.cleanupFailures].map(([key, reason]) => `${key}: ${reason}`) }
  }

  private async draft(scope: PluginScope, name: string, cwd: string) {
    checkName(name)
    if (scope === "project" && ((await findProjectRoot(cwd)) !== this.root || !(await isTrusted(this.root)))) {
      throw new Error("project plugins require the trusted launch project; reopen Xal in the intended project")
    }
    const path = join(this.directories[scope], name, "plugin.ts")
    const boundary = scope === "user" ? this.home : this.root
    const source = readPluginDraft(boundary, relative(boundary, path), MAX_PLUGIN_BYTES)
    return { path, source, sha256: digest(source) }
  }

  async inspect(scope: PluginScope, name: string, cwd: string) {
    const { path, sha256 } = await this.draft(scope, name, cwd)
    return { scope, name, path, sha256 }
  }

  private checkOwner(scope: PluginScope, name: string): void {
    const owner = this.active.get(name)
    if (this.startupPlugins().includes(name) || (owner && owner.scope !== scope)) {
      throw new Error(`plugin name already registered in another scope: ${name}`)
    }
  }

  private replace(
    scope: PluginScope,
    name: string,
    sha256: string,
    contributions: LiveContributions,
    commit?: () => void,
  ) {
    this.checkOwner(scope, name)
    const previous = this.active.get(name)
    previous?.remove()
    try {
      const remove = installContributions(contributions, commit)
      this.active.set(name, { scope, sha256, contributions, remove })
    } catch (error) {
      if (previous) previous.remove = installContributions(previous.contributions)
      throw error
    }
  }

  async activate(scope: PluginScope, name: string, expected: string, cwd: string, signal: AbortSignal): Promise<void> {
    this.checkOwner(scope, name)
    const { source, sha256 } = await this.draft(scope, name, cwd)
    if (sha256 !== expected)
      throw new Error("plugin.ts does not match the inspected sha256; inspect the new draft before activating")
    if (scope === "project" && !(await isTrusted(this.root)))
      throw new Error("project plugin activation requires the trusted launch project")
    const contributions = await stageLivePlugin(name, source, signal)
    const file = this.approvedFile(scope, name)
    await withPublicationLock(this.home, async () => {
      if (scope === "project" && !(await isTrusted(this.root)))
        throw new Error("project plugin activation requires the trusted launch project")
      withApprovalLock(this.home, () => {
        signal.throwIfAborted()
        const saved = readApproval(this.home, file)
        const pending = this.tracked[scope].get(name)?.pending
        const previous =
          saved &&
          this.discardRevoked(
            scope,
            name,
            saved.installation,
            saved,
            pending?.installation === saved.installation ? pending.generation : undefined,
          )
        const revision = randomUUID()
        const installation = previous?.installation ?? revision
        const generation = previous ? previous.generation + 1 : 0
        if (!Number.isSafeInteger(generation)) throw new Error("approved plugin generation exhausted")
        const directory = dirname(file)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const tmp = join(directory, `.${revision}.tmp`)
        try {
          writeFileSync(tmp, JSON.stringify({ source, sha256, installation, revision, generation }), {
            flag: "wx",
            mode: 0o600,
          })
          this.replace(scope, name, sha256, contributions, () => {
            if (!this.hasFolder(scope, name)) throw new Error(`plugin folder no longer exists: ${name}`)
            renameSync(tmp, file)
          })
          this.track(scope, name, { installation, generation })
        } finally {
          rmSync(tmp, { force: true })
        }
      })
    })
  }

  async restore(signal: AbortSignal): Promise<PluginFailure[]> {
    const failures: PluginFailure[] = []
    for (const scope of ["user", "project"] as const) {
      const directory = this.store(scope)
      let names: string[]
      try {
        if (scope === "project" && !(await isTrusted(this.root))) continue
        if (!scopedPathExists(this.home, directory, "directory")) continue
        names = await readdir(directory)
      } catch (error) {
        if (!notFound(error)) failures.push({ plugin: directory, phase: "bootstrap", reason: describeError(error) })
        continue
      }
      for (const file of names.sort()) {
        if (signal.aborted) return failures
        if (!file.endsWith(".json")) continue
        const name = file.slice(0, -5)
        try {
          if (scope === "project" && !(await isTrusted(this.root))) break
          checkName(name)
          const saved = readApproval(this.home, join(directory, file))
          if (!saved) continue
          const entry = this.track(scope, name, saved)
          const stage = await withPublicationLock(this.home, async () => {
            if (scope === "project" && !(await isTrusted(this.root))) return
            if (signal.aborted || this.tracked[scope].get(name) !== entry) return
            const snapshot = this.reconcile(scope, name, entry)
            if (snapshot) return { snapshot, staged: this.track(scope, name, snapshot) }
          })
          if (!stage) continue
          const { snapshot, staged } = stage
          this.checkOwner(scope, name)
          if (scope === "project" && !(await isTrusted(this.root))) break
          const contributions = await stageLivePlugin(name, snapshot.source, signal)
          await withPublicationLock(this.home, async () => {
            if (scope === "project" && !(await isTrusted(this.root))) return
            if (signal.aborted || this.tracked[scope].get(name) !== staged) return
            const current = this.reconcile(scope, name, staged)
            if (
              current?.installation === snapshot.installation &&
              current.revision === snapshot.revision &&
              current.generation === snapshot.generation &&
              current.sha256 === snapshot.sha256
            )
              this.replace(scope, name, snapshot.sha256, contributions)
          })
        } catch (error) {
          if (signal.aborted) return failures
          failures.push({ plugin: `${scope}:${name}`, phase: "bootstrap", reason: describeError(error) })
        }
      }
    }
    return failures
  }
}
