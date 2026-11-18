import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { agentHome, projectConfigPath } from "../../config/paths"
import type { PluginFailure } from "../../events"
import { describeError } from "../../lib/error"
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
  pending?: ApprovalVersion
}

function checkName(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error("expected a lower-case plugin name, up to 64 characters")
}

export class LivePlugins {
  private readonly active = new Map<string, ActivePlugin>()
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
    const pending = entry.pending
    const generation =
      pending?.installation === version.installation
        ? Math.max(pending.generation, version.generation)
        : version.generation
    entry.pending = { installation: version.installation, generation }
    if (pending?.installation !== version.installation) {
      this.unload(scope, name)
      removed?.push(`${scope}:${name}`)
    }
    recordRevocation(
      this.home,
      revocationFile(this.home, this.approvedFile(scope, name), version.installation),
      generation,
    )
  }

  private discardRevoked(
    scope: PluginScope,
    name: string,
    installation: string,
    current: ReturnType<typeof readApproval>,
  ) {
    const file = this.approvedFile(scope, name)
    const marker = revocationFile(this.home, file, installation)
    if (current?.installation === installation) {
      if (current.generation > revokedThrough(this.home, marker)) return current
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
    const cutoff =
      !missing && saved ? revokedThrough(this.home, revocationFile(this.home, file, saved.installation)) : -1
    if (saved && (missing || saved.generation <= cutoff)) this.retire(scope, name, entry, saved, removed)
    else if (entry.pending && saved?.installation === entry.pending.installation)
      this.retire(scope, name, entry, entry.pending, removed)
    if (entry.pending) {
      const retired = entry.pending
      withApprovalLock(this.home, () => {
        const latest = readApproval(this.home, file)
        let current = this.discardRevoked(scope, name, retired.installation, latest)
        if (current && !this.hasFolder(scope, name)) {
          this.retire(scope, name, entry, current, removed)
          current = this.discardRevoked(scope, name, current.installation, current)
        }
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
    const failures: string[] = []
    for (const scope of ["user", "project"] as const) {
      const entries = this.tracked[scope]
      if (!entries.size || !canRemove()) continue
      try {
        if (scope === "project" && !(await isTrusted(this.root))) continue
      } catch (error) {
        failures.push(`${scope}: ${describeError(error)}`)
        continue
      }
      for (const [name, entry] of entries) {
        if (!canRemove()) break
        const file = this.approvedFile(scope, name)
        try {
          const marker = revocationFile(this.home, file, entry.installation)
          if (
            !entry.pending &&
            (await unchangedApproval(join(this.directories[scope], name), file, marker, entry.stamp))
          )
            continue
          await withPublicationLock(this.home, async () => {
            if (scope === "project" && !(await isTrusted(this.root))) return
            if (!canRemove() || entries.get(name) !== entry) return
            this.reconcile(scope, name, entry, removed)
          })
        } catch (error) {
          failures.push(`${scope}:${name}: ${describeError(error)}`)
        }
      }
    }
    return { removed, failures }
  }

  private async draft(scope: PluginScope, name: string, cwd: string) {
    checkName(name)
    if (scope === "project" && ((await findProjectRoot(cwd)) !== this.root || !(await isTrusted(this.root)))) {
      throw new Error("project plugins require the trusted launch project; reopen Xal in the intended project")
    }
    const path = join(this.directories[scope], name, "plugin.ts")
    const boundary = scope === "user" ? this.home : this.root
    const canonical = await realpath(path)
    if (canonical !== join(await realpath(boundary), relative(boundary, path))) {
      throw new Error("live plugin drafts cannot be symlinks or inside symlinked directories")
    }
    const info = await stat(canonical)
    if (!info.isFile() || info.size > MAX_PLUGIN_BYTES)
      throw new Error("plugin.ts must be a regular file of at most 64 KiB")
    const bytes = await readFile(canonical)
    if (bytes.length > MAX_PLUGIN_BYTES) throw new Error("plugin.ts exceeds 64 KiB")
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
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
    const contributions = await stageLivePlugin(name, source, signal)
    const file = this.approvedFile(scope, name)
    await withPublicationLock(this.home, async () => {
      if (scope === "project" && !(await isTrusted(this.root)))
        throw new Error("project plugin activation requires the trusted launch project")
      withApprovalLock(this.home, () => {
        signal.throwIfAborted()
        const saved = readApproval(this.home, file)
        const previous = saved && this.discardRevoked(scope, name, saved.installation, saved)
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

  async restore(): Promise<PluginFailure[]> {
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
        if (!file.endsWith(".json")) continue
        const name = file.slice(0, -5)
        try {
          if (scope === "project" && !(await isTrusted(this.root))) break
          checkName(name)
          const saved = readApproval(this.home, join(directory, file))
          if (!saved) continue
          const entry = this.track(scope, name, saved)
          const snapshot = await withPublicationLock(this.home, async () => {
            if (scope === "project" && !(await isTrusted(this.root))) return
            return this.reconcile(scope, name, entry)
          })
          if (!snapshot) continue
          this.track(scope, name, snapshot)
          this.checkOwner(scope, name)
          const contributions = await stageLivePlugin(name, snapshot.source)
          this.replace(scope, name, snapshot.sha256, contributions)
        } catch (error) {
          failures.push({ plugin: `${scope}:${name}`, phase: "bootstrap", reason: describeError(error) })
        }
      }
    }
    return failures
  }
}
