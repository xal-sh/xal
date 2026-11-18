import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
} from "../../agent/session/test-support"
import { getCommand, registerCommand } from "../../commands/registry"
import { agentHome } from "../../config/paths"
import { createNativeSessionLock } from "../../native"
import { RuntimeReloader } from "../../config/reload"
import { events } from "../../events"
import { forgetTrusted, isTrusted, rememberTrusted } from "../../project/trust"
import * as trust from "../../project/trust"
import { getTool, registerTool } from "../../tools/registry"
import { getToolRenderer, registerToolRenderer } from "../../ui/extension"
import { writeTool } from "../files/write"
import * as approval from "./approval"
import * as contributions from "./contributions"
import { LivePlugins, type PluginScope } from "./manager"
import { registerLivePluginTools } from "./tools"

let harness: AgentSessionTestHarness
let plugins: LivePlugins
let root: string
const signal = new AbortController().signal

beforeAll(async () => {
  harness = await setupAgentSessionTests("live-plugins-")
  root = join(await realpath(agentHome()), "project")
  await mkdir(join(root, ".git"), { recursive: true })
  await rememberTrusted(root)
  plugins = new LivePlugins(root, () => ["tui"])
  registerLivePluginTools(plugins)
  registerTool(writeTool)
})
afterAll(() => harness.cleanup())

async function draft(scope: PluginScope, name: string, source: string) {
  const path = join(plugins.directories[scope], name, "plugin.ts")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source)
  return plugins.inspect(scope, name, root)
}

test("the agent can write the documented example, activate it, and use the tool on its next model request", async () => {
  const docs = await readFile(join(import.meta.dir, "../../../../../docs/plugins.md"), "utf8")
  const source = docs.match(/```ts\n([\s\S]+?)\n```/)![1]!
  const identity = { name: "word-count", scope: "project" }
  const activate = { ...identity, sha256: createHash("sha256").update(source).digest("hex") }
  const provider = new ScriptedProvider([
    toolRound("draft", "write", {
      file_path: join(plugins.directories.project, "word-count/plugin.ts"),
      content: source,
    }),
    toolRound("inspect", "xal_info", identity),
    toolRound("activate", "activate_plugin", activate),
    toolRound("use", "word_count", { text: "one two three" }),
    completedRound("Counted."),
  ])
  const session = harness.createSession(provider, { cwd: root })
  const approvals: string[] = []
  const outcome = await runSettledTurn(session, { text: "Create a word counter", images: [] }, (event) => {
    if (event.type !== "approval_requested") return
    approvals.push(event.tool)
    session.approve()
  })
  expect(outcome.status).toBe("completed")
  expect(approvals).toContain("activate_plugin")
  expect(provider.requests[2]?.input.at(-1)).toMatchObject({ output: expect.stringContaining(activate.sha256) })
  expect(provider.requests[2]?.tools.map((tool) => tool.name)).not.toContain("word_count")
  expect(provider.requests[3]?.tools.map((tool) => tool.name)).toContain("word_count")
  expect(provider.requests[4]?.input.at(-1)).toMatchObject({ output: "3" })
  expect(getToolRenderer("word_count")?.summarize?.("3")).toBe("3 words")
  expect(getCommand("words")).toBeDefined()

  const changed = await draft("project", "word-count", source.replace("Count words", "New title"))
  await expect(plugins.activate("project", "word-count", activate.sha256, root, signal)).rejects.toThrow("sha256")
  const denied = new ScriptedProvider([
    toolRound("denied", "activate_plugin", { ...identity, sha256: changed.sha256 }),
    completedRound("Left unchanged."),
  ])
  const second = harness.createSession(denied, { cwd: root })
  await runSettledTurn(second, { text: "Update it", images: [] }, (event) => {
    if (event.type === "approval_requested") second.deny()
  })
  expect(denied.requests[1]?.input.at(-1)).toMatchObject({ output: expect.stringContaining("denied") })
  expect(plugins.list().find((entry) => entry.name === "word-count")?.sha256).toBe(activate.sha256)
  await plugins.activate("project", "word-count", changed.sha256, root, signal)
  const working = getTool("word_count")
  expect(working?.title({}, { cwd: root })).toBe("New title")
  const approved = plugins.list().find((entry) => entry.name === "word-count")!.approvedFile
  const snapshot = await readFile(approved, "utf8")
  const invalid = await draft(
    "project",
    "word-count",
    source.replace('properties: { text: { type: "string" } }', "properties: []"),
  )
  await expect(plugins.activate("project", "word-count", invalid.sha256, root, signal)).rejects.toThrow(
    "invalid parameter schema",
  )
  expect(getTool("word_count")).toBe(working)
  expect(await readFile(approved, "utf8")).toBe(snapshot)
})

function commandPlugin(name: string, alias: string, extra = ""): string {
  return `export default { name: ${JSON.stringify(name)}, register(ctx) {
    ctx.registerCommand({ name: ${JSON.stringify(name)}, aliases: [${JSON.stringify(alias)}], describe: "test", async run() {} })
    ${extra}
  } }`
}

async function activateCommand(scope: PluginScope, name: string, extra = "") {
  const { path, sha256 } = await draft(scope, name, commandPlugin(name, `${name}-alias`, extra))
  await plugins.activate(scope, name, sha256, root, signal)
  const { approvedFile } = plugins.list().find((entry) => entry.name === name)!
  return { folder: dirname(path), path, approvedFile, scope, name }
}

async function restart(
  cwd: string,
  home = agentHome(),
  action?: { type: "activate" | "delete"; scope: PluginScope; name: string; skipRestore?: boolean },
): Promise<unknown> {
  const script = `import {rm} from "node:fs/promises";
    import {join} from "node:path";
    import {registerApp, finishApp} from "./app";
    import {bootstrapPlugins} from "./plugins/discover";
    import {getLivePlugins} from "./plugins/live/registry";
    import {listCommands} from "./commands/registry";
    import {loadSettings} from "./config/settings";
    process.chdir(process.argv[1]);
    await registerApp(await loadSettings());
    const action = JSON.parse(process.argv[2]);
    const {failures} = action?.skipRestore ? {failures: []} : await bootstrapPlugins();
    let removal;
    if (action) {
      const {type, scope, name} = action;
      const plugins = getLivePlugins();
      if (type === "delete") {
        await rm(join(plugins.directories[scope], name), {recursive: true});
        removal = await plugins.removeDeleted(() => true);
      } else {
        const {sha256} = await plugins.inspect(scope, name, process.cwd());
        await plugins.activate(scope, name, sha256, process.cwd(), new AbortController().signal);
      }
    }
    const commands = Object.fromEntries(listCommands().flatMap(c => [c.name, ...c.aliases ?? []].map(key => [key, c.name])));
    console.log(JSON.stringify({commands, failures, removal}));
    await finishApp();`
  const child = Bun.spawn([process.execPath, "--eval", script, cwd, JSON.stringify(action ?? null)], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, XAL_HOME: home, HOME: home, USERPROFILE: home },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
  if (exit !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

test("restores only approved source for each scope and preserves the working revision when a replacement conflicts", async () => {
  const user = await draft("user", "my-user", commandPlugin("my-user", "user-alias"))
  await plugins.activate("user", "my-user", user.sha256, root, signal)
  const project = await draft("project", "my-project", commandPlugin("my-project", "old-alias"))
  await plugins.activate("project", "my-project", project.sha256, root, signal)
  const updated = await draft("project", "my-project", commandPlugin("my-project", "current-alias"))
  await plugins.activate("project", "my-project", updated.sha256, root, signal)
  expect(getCommand("old-alias")).toBeUndefined()
  registerCommand({ name: "taken", describe: "reserved", async run() {} })
  const bad = await draft("project", "my-project", commandPlugin("my-project", "taken"))
  await expect(plugins.activate("project", "my-project", bad.sha256, root, signal)).rejects.toThrow(
    "already registered",
  )
  expect(getCommand("current-alias")?.name).toBe("my-project")
  expect(getCommand("taken")?.name).toBe("taken")
  const external = await draft(
    "project",
    "my-project",
    'import { plugin } from "./extra" with { type: "macro" }; export default plugin()',
  )
  await expect(plugins.activate("project", "my-project", external.sha256, root, signal)).rejects.toThrow(
    "unsupported import: ./extra",
  )

  await draft("project", "my-project", "throw Error('unapproved draft ran')")
  expect(await restart(root)).toMatchObject({
    commands: { "current-alias": "my-project", "user-alias": "my-user" },
    failures: [],
  })
  const other = join(dirname(root), "other")
  await mkdir(other)
  await rememberTrusted(other)
  const elsewhere = await restart(other)
  expect(elsewhere).toMatchObject({ commands: { "user-alias": "my-user" }, failures: [] })
  expect(elsewhere).not.toHaveProperty("commands.my-project")
  const templates = join(other, ".xal", "commands")
  await mkdir(templates, { recursive: true })
  await writeFile(join(templates, "user-alias.md"), "Project command")
  await writeFile(join(templates, "unrelated.md"), "Another project command")
  expect(await restart(other)).toMatchObject({
    commands: { "user-alias": "user-alias", unrelated: "unrelated" },
    failures: [{ plugin: "user:my-user", phase: "bootstrap", reason: expect.stringContaining("already registered") }],
  })
  await forgetTrusted(root)
  try {
    const untrusted = await restart(root)
    expect(untrusted).toMatchObject({ commands: { "user-alias": "my-user" }, failures: [] })
    expect(untrusted).not.toHaveProperty("commands.my-project")
    await expect(plugins.inspect("project", "my-project", root)).rejects.toThrow("trusted launch project")
  } finally {
    await rememberTrusted(root)
  }
})

test("draft inspection fingerprints exact UTF-8 bytes and rejects oversized files and links", async () => {
  const name = "draft-boundary"
  const source = "\uFEFF" + "x".repeat(approval.MAX_PLUGIN_BYTES - 3)
  const { path, sha256 } = await draft("user", name, source)
  expect(sha256).toBe(createHash("sha256").update(source).digest("hex"))
  const inspect = () => plugins.inspect("user", name, root)
  await writeFile(path, source + "!")
  await expect(inspect()).rejects.toThrow("65536")
  await writeFile(path, Buffer.from([0xff]))
  await expect(inspect()).rejects.toThrow("cannot read plugin draft")
  await writeFile(path, source)
  await rename(path, `${path}.saved`)
  await symlink(`${path}.saved`, path, "file")
  await expect(inspect()).rejects.toThrow("cannot read plugin draft")
  await rm(path)
  await rename(`${path}.saved`, path)
  const folder = dirname(path)
  await rename(folder, `${folder}-saved`)
  await symlink(`${folder}-saved`, folder, "dir")
  await expect(inspect()).rejects.toThrow("cannot read plugin draft")
})

function revokeAfterNextTrustRead() {
  const check = trust.isTrusted
  return spyOn(trust, "isTrusted").mockImplementationOnce(async (cwd) => {
    const trusted = await check(cwd)
    await forgetTrusted(cwd)
    return trusted
  })
}

test("revoking project trust after inspection prevents staging the approved draft", async () => {
  const name = "trust-before-stage"
  const { sha256 } = await draft("project", name, commandPlugin(name, "never-staged"))
  const probe = revokeAfterNextTrustRead()
  const stage = spyOn(contributions, "stageLivePlugin")
  try {
    await expect(plugins.activate("project", name, sha256, root, signal)).rejects.toThrow("trusted launch project")
    expect(stage).not.toHaveBeenCalled()
  } finally {
    stage.mockRestore()
    probe.mockRestore()
    await rememberTrusted(root)
  }
})

test("startup skips a staged plugin whose draft folder disappeared during registration", async () => {
  const name = "removed-during-restore"
  const folder = join(plugins.directories.user, name)
  const trigger = join(agentHome(), "delete-on-restore")
  const source = `import {existsSync, rmSync} from "node:fs";\n${commandPlugin(name, "should-not-restore", `if (existsSync(${JSON.stringify(trigger)})) rmSync(${JSON.stringify(folder)}, { recursive: true })`)}`
  const { sha256 } = await draft("user", name, source)
  await plugins.activate("user", name, sha256, root, signal)
  await writeFile(trigger, "")
  const state = await restart(root)
  expect(state).toMatchObject({ failures: [] })
  expect(state).not.toHaveProperty(`commands.${name}`)
  expect((await plugins.removeDeleted(() => true)).removed).toContain(`user:${name}`)
})

test("startup forgets deleted plugin folders in either scope but not a missing plugin.ts", async () => {
  const entries = [await activateCommand("user", "offline-user"), await activateCommand("project", "offline-project")]
  const keep = await activateCommand("user", "offline-keep")
  const legacy = entries[0]!
  const source = await readFile(legacy.path, "utf8")
  await writeFile(
    legacy.approvedFile,
    JSON.stringify({ source, sha256: createHash("sha256").update(source).digest("hex") }),
  )
  for (const entry of entries) await rm(entry.path)
  const editing = await restart(root)
  expect(editing).toMatchObject({ failures: [] })
  for (const { name } of entries) expect(editing).toHaveProperty(`commands.${name}-alias`, name)

  for (const entry of entries) await rm(entry.folder, { recursive: true })
  const deleted = await restart(root)
  expect(deleted).toMatchObject({ commands: { [keep.name]: keep.name }, failures: [] })
  for (const { approvedFile, name, scope } of entries) {
    expect(deleted).not.toHaveProperty(`commands.${name}-alias`)
    expect(await Bun.file(approvedFile).exists()).toBe(false)
    await draft(scope, name, commandPlugin(name, "recreated-alias"))
  }
  const recreated = await restart(root)
  expect(recreated).toMatchObject({ commands: { [keep.name]: keep.name }, failures: [] })
  for (const { name } of entries) expect(recreated).not.toHaveProperty(`commands.${name}`)
  const { removed, failures } = await plugins.removeDeleted(() => true)
  expect(failures).toEqual([])
  for (const { name, scope } of entries) {
    expect(removed).toContain(`${scope}:${name}`)
    expect(getCommand(name)).toBeUndefined()
  }
})

test("idle reload uninstalls only deleted folders, releases every contribution, and leaves other approvals intact", async () => {
  const fallback = { tool: "deleted_tool", summarize: () => "startup renderer" }
  registerToolRenderer(fallback)
  const local = await activateCommand(
    "project",
    "idle-local",
    `
    ctx.registerTool({ name: "deleted_tool", description: "test", parameters: {type: "object"}, title: () => "test", async execute() { return { output: "test" } } })
    ctx.registerToolRenderer({ tool: "deleted_tool", summarize: () => "live renderer" })`,
  )
  const user = await activateCommand("user", "idle-user")
  const retained = await readFile(user.approvedFile, "utf8")
  const notices: string[] = []
  const unsubscribe = events.subscribe((event) => {
    if (event.type === "runtime_reload" && event.source === "plugins") notices.push(event.message)
  })
  let idle = true
  const reloader = new RuntimeReloader(root, () => idle, plugins)
  try {
    await rm(local.path)
    await writeFile(user.path, "throw Error('unapproved draft ran')")
    await reloader.refresh()
    expect(getToolRenderer("deleted_tool")?.summarize?.("")).toBe("live renderer")
    expect(getCommand("idle-user-alias")).toBeDefined()
    expect(notices).toEqual([])

    idle = false
    await rm(local.folder, { recursive: true })
    await reloader.refresh()
    const tool = getTool("deleted_tool")!
    tool.name = "renamed_after_registration"
    expect(await Bun.file(local.approvedFile).exists()).toBe(true)
    idle = true
    await reloader.refresh()
    expect(getTool("deleted_tool")).toBeUndefined()
    expect(getCommand("idle-local")).toBeUndefined()
    expect(getCommand("idle-local-alias")).toBeUndefined()
    expect(getToolRenderer("deleted_tool")).toBe(fallback)
    expect(plugins.list().some(({ name }) => name === local.name)).toBe(false)
    expect(await Bun.file(local.approvedFile).exists()).toBe(false)
    expect(getCommand("idle-user-alias")).toBeDefined()
    expect(await readFile(user.approvedFile, "utf8")).toBe(retained)
    expect(notices).toEqual([expect.stringContaining("project:idle-local")])

    await rename(user.folder, `${user.folder}-backup`)
    await writeFile(user.folder, "not a directory")
    await reloader.refresh()
    await reloader.refresh()
    expect(notices).toEqual([expect.any(String), expect.stringContaining("expected a plugin directory")])
    expect(getCommand("idle-user-alias")).toBeDefined()
    expect(await readFile(user.approvedFile, "utf8")).toBe(retained)
    await rm(user.folder)
    await reloader.refresh()
    expect(getCommand("idle-user-alias")).toBeUndefined()
    expect(await Bun.file(user.approvedFile).exists()).toBe(false)
    expect(notices.at(-1)).toContain("user:idle-user")
  } finally {
    unsubscribe()
    await reloader.stop()
  }
})

test("idle cleanup retries a valid approval whose folder could not be checked at startup", async () => {
  const user = await activateCommand("user", "startup-retry")
  const { name, scope } = user
  await rm(user.folder, { recursive: true })
  await writeFile(user.folder, "not a directory")
  expect(await restart(root, agentHome(), { type: "delete", name, scope })).toMatchObject({
    failures: expect.arrayContaining([
      { plugin: `user:${name}`, phase: "bootstrap", reason: expect.stringContaining("expected a plugin directory") },
    ]),
    removal: { removed: expect.arrayContaining([`user:${name}`]), failures: [] },
  })
  expect(await Bun.file(user.approvedFile).exists()).toBe(false)
  await writeFile(user.folder, "not a directory anymore")
  expect(await plugins.removeDeleted(() => true)).toMatchObject({
    removed: expect.arrayContaining([`user:${name}`]),
    failures: [],
  })
  expect(getCommand(name)).toBeUndefined()
  await rm(user.folder)
  await mkdir(user.folder)
  expect(await restart(root)).not.toHaveProperty(`commands.${name}`)
})

test("a dangling plugin root is not evidence that its plugins were uninstalled", async () => {
  const user = await activateCommand("user", "link-keep")
  const directory = plugins.directories.user
  await rename(directory, `${directory}-saved`)
  try {
    await symlink(`${directory}-missing`, directory, "dir")
    const state = await restart(root)
    expect(state).toMatchObject({
      failures: expect.arrayContaining([
        { plugin: "user:link-keep", phase: "bootstrap", reason: expect.stringContaining(directory) },
      ]),
    })
    expect(await Bun.file(user.approvedFile).exists()).toBe(true)
    const { removed, failures } = await plugins.removeDeleted(() => true)
    expect(removed).not.toContain("user:link-keep")
    expect(failures).toContainEqual(expect.stringContaining(directory))
    expect(getCommand(user.name)).toBeDefined()
  } finally {
    await rm(directory, { force: true })
    await rename(`${directory}-saved`, directory)
  }
})

test("uninstall never follows a linked approval directory and retries only the scoped approval", async () => {
  const local = await activateCommand("project", "scoped-removal")
  const store = dirname(local.approvedFile)
  const otherStore = join(dirname(store), "another-project")
  await mkdir(otherStore)
  const otherFile = join(otherStore, `${local.name}.json`)
  const saved = await readFile(local.approvedFile, "utf8")
  await writeFile(otherFile, saved)
  await rm(local.folder, { recursive: true })
  await rename(store, `${store}-saved`)
  try {
    await symlink(otherStore, store, "dir")
    expect(await restart(root)).toMatchObject({ failures: [{ plugin: store, phase: "bootstrap" }] })
    const { removed, failures } = await plugins.removeDeleted(() => true)
    expect(removed).toContain("project:scoped-removal")
    expect(failures).toContainEqual(expect.stringContaining(store))
    expect(getCommand(local.name)).toBeUndefined()
    expect(await readFile(otherFile, "utf8")).toBe(saved)
    await mkdir(local.folder)
  } finally {
    await rm(store, { force: true })
    await rename(`${store}-saved`, store)
  }
  expect((await plugins.removeDeleted(() => true)).failures).toEqual([])
  expect(await Bun.file(local.approvedFile).exists()).toBe(false)
  expect(await readFile(otherFile, "utf8")).toBe(saved)
})

test("a zero-byte revocation marker accepts the next generation but malformed content does not", async () => {
  const home = agentHome()
  const marker = join(home, "partial-revocation")
  await writeFile(marker, "")
  approval.recordRevocation(home, marker, 4)
  expect(approval.revokedThrough(home, marker)).toBe(4)
  await writeFile(marker, "bad\n")
  expect(() => approval.recordRevocation(home, marker, 5)).toThrow("invalid plugin revocation")
})

test("a local-only unload is reported as incomplete until the matching approval is durably removed", async () => {
  const user = await activateCommand("user", "unrecorded-delete")
  const home = agentHome()
  const saved = approval.readApproval(home, user.approvedFile)!
  const marker = approval.revocationFile(home, user.approvedFile, saved.installation)
  const record = approval.recordRevocation
  const failed = spyOn(approval, "recordRevocation").mockImplementation((home, path, generation) => {
    if (path === marker) throw new Error("marker unavailable")
    record(home, path, generation)
  })
  try {
    const lock = createNativeSessionLock(join(home, "approved-plugins.lock"))
    try {
      await rm(user.folder, { recursive: true })
      const result = await plugins.removeDeleted(() => true)
      expect(result.removed).not.toContain(`user:${user.name}`)
      expect(result.failures).toContainEqual(
        expect.stringContaining("Unloaded locally; other sessions may still restore"),
      )
      expect(getCommand(user.name)).toBeUndefined()
      await mkdir(user.folder)
      expect(await restart(root)).toHaveProperty(`commands.${user.name}`, user.name)
    } finally {
      lock.close()
    }
    expect(await plugins.removeDeleted(() => true)).toMatchObject({
      removed: expect.arrayContaining([`user:${user.name}`]),
      failures: [],
    })
    expect(await Bun.file(user.approvedFile).exists()).toBe(false)
    expect(await restart(root)).not.toHaveProperty(`commands.${user.name}`)
  } finally {
    failed.mockRestore()
  }
})

test("a cleanup retry never removes a newer activation, even of identical source", async () => {
  const user = await activateCommand("user", "retry-install")
  const source = await readFile(user.path, "utf8")
  await rm(user.folder, { recursive: true })
  const lock = createNativeSessionLock(join(agentHome(), "approved-plugins.lock"))
  try {
    const { removed, failures } = await plugins.removeDeleted(() => true)
    expect(removed).toContain("user:retry-install")
    expect(failures).toContainEqual(expect.stringContaining("user:retry-install"))
    expect(getCommand(user.name)).toBeUndefined()
    expect(await Bun.file(user.approvedFile).exists()).toBe(true)
  } finally {
    lock.close()
  }
  await draft(user.scope, user.name, source)
  await restart(root, agentHome(), { type: "activate", scope: user.scope, name: user.name })
  const fresh = await readFile(user.approvedFile, "utf8")
  expect((await plugins.removeDeleted(() => true)).failures).toEqual([])
  expect(getCommand(user.name)).toBeUndefined()
  expect(await readFile(user.approvedFile, "utf8")).toBe(fresh)
  expect(await restart(root)).toHaveProperty(`commands.${user.name}`, user.name)
})

test("a cleanup retry processes a second deletion of a freshly activated installation", async () => {
  const user = await activateCommand("user", "deleted-again")
  const { name, scope } = user
  const source = await readFile(user.path, "utf8")
  await rm(user.folder, { recursive: true })
  const lock = createNativeSessionLock(join(agentHome(), "approved-plugins.lock"))
  try {
    expect(await plugins.removeDeleted(() => true)).toMatchObject({
      removed: expect.arrayContaining([`user:${name}`]),
      failures: expect.arrayContaining([expect.stringContaining(name)]),
    })
  } finally {
    lock.close()
  }
  await draft(scope, name, source)
  await restart(root, agentHome(), { type: "activate", scope, name, skipRestore: true })
  await rm(user.folder, { recursive: true })
  expect((await plugins.removeDeleted(() => true)).failures).toEqual([])
  expect(await Bun.file(user.approvedFile).exists()).toBe(false)
  await mkdir(user.folder)
  expect(await restart(root)).not.toHaveProperty(`commands.${name}`)
})

test("an approval updated before the poll stays revoked when the folder returns before cleanup", async () => {
  const user = await activateCommand("user", "before-delete")
  const { name, scope } = user
  await draft(scope, name, commandPlugin(name, "before-delete-new"))
  await restart(root, agentHome(), { type: "activate", scope, name })
  const updated = await readFile(user.approvedFile, "utf8")
  await rm(user.folder, { recursive: true })
  const lock = createNativeSessionLock(join(agentHome(), "approved-plugins.lock"))
  let recreated = false
  const exists = approval.scopedPathExists
  const probe = spyOn(approval, "scopedPathExists").mockImplementation((home, path, kind) => {
    const result = exists(home, path, kind)
    if (path === user.folder && !result && !recreated) {
      mkdirSync(path)
      recreated = true
    }
    return result
  })
  try {
    expect(await plugins.removeDeleted(() => true)).toMatchObject({
      removed: expect.arrayContaining([`user:${name}`]),
      failures: expect.arrayContaining([expect.stringContaining(name)]),
    })
    expect(recreated).toBe(true)
    const waiting = await restart(root)
    expect(waiting).not.toHaveProperty(`commands.${name}`)
    expect(waiting).toMatchObject({
      failures: expect.arrayContaining([{ plugin: `user:${name}`, phase: "bootstrap", reason: expect.any(String) }]),
    })
    expect(await readFile(user.approvedFile, "utf8")).toBe(updated)
  } finally {
    probe.mockRestore()
    lock.close()
  }
  expect((await plugins.removeDeleted(() => true)).failures).toEqual([])
  expect(await Bun.file(user.approvedFile).exists()).toBe(false)
  expect(await restart(root)).not.toHaveProperty("commands.before-delete-new")
})

test("a busy observer drops its plugin after another session reinstalls over an unremoved approval", async () => {
  const user = await activateCommand("user", "blocked-reinstall")
  const { name, scope } = user
  const source = await readFile(user.path, "utf8")
  const lock = createNativeSessionLock(join(agentHome(), "approved-plugins.lock"))
  try {
    expect(await restart(root, agentHome(), { type: "delete", scope, name })).toMatchObject({
      failures: [],
      removal: { removed: [`user:${name}`], failures: [expect.stringContaining(name)] },
    })
    expect(await Bun.file(user.approvedFile).exists()).toBe(true)
    expect(getCommand(name)).toBeDefined()
  } finally {
    lock.close()
  }
  await draft(scope, name, source)
  expect(await restart(root, agentHome(), { type: "activate", scope, name, skipRestore: true })).toHaveProperty(
    `commands.${name}`,
    name,
  )
  const fresh = await readFile(user.approvedFile, "utf8")
  expect(await plugins.removeDeleted(() => true)).toMatchObject({
    removed: expect.arrayContaining([`user:${name}`]),
    failures: [],
  })
  expect(getCommand(name)).toBeUndefined()
  expect(await readFile(user.approvedFile, "utf8")).toBe(fresh)
  expect(await restart(root)).toHaveProperty(`commands.${name}`, name)
})

test("a busy second session retains an in-place update but unloads a reinstalled plugin without running it", async () => {
  const user = await activateCommand("user", "two-sessions")
  const old = getCommand("two-sessions-alias")
  const identity = { scope: user.scope, name: user.name }
  const update = commandPlugin(user.name, "two-sessions-new")
  await draft(user.scope, user.name, update)
  await restart(root, agentHome(), { type: "activate", ...identity })
  expect((await plugins.removeDeleted(() => true)).removed).not.toContain("user:two-sessions")
  expect(getCommand("two-sessions-alias")).toBe(old)
  expect(await restart(root, agentHome(), { type: "delete", ...identity })).toMatchObject({ removal: { failures: [] } })
  await draft(user.scope, user.name, update)
  await restart(root, agentHome(), { type: "activate", ...identity })
  const fresh = await readFile(user.approvedFile, "utf8")
  expect((await plugins.removeDeleted(() => true)).removed).toContain("user:two-sessions")
  expect(getCommand("two-sessions-alias")).toBeUndefined()
  expect(getCommand("two-sessions-new")).toBeUndefined()
  expect(await readFile(user.approvedFile, "utf8")).toBe(fresh)
})

test("a blocked approval is uninstalled without removing the command that won the collision", async () => {
  const user = await activateCommand("user", "blocked-plugin")
  const other = join(dirname(root), "command-owner")
  const templates = join(other, ".xal", "commands")
  await mkdir(templates, { recursive: true })
  await rememberTrusted(other)
  await writeFile(join(templates, "blocked-plugin-alias.md"), "Project command")
  expect(await restart(other, agentHome(), { type: "delete", scope: user.scope, name: user.name })).toMatchObject({
    commands: { "blocked-plugin-alias": "blocked-plugin-alias" },
    failures: [{ plugin: "user:blocked-plugin", reason: expect.stringContaining("already registered") }],
  })
  expect(await Bun.file(user.approvedFile).exists()).toBe(false)
  await mkdir(user.folder)
  expect(await restart(root)).not.toHaveProperty("commands.blocked-plugin")
})

test("revoked project trust prevents project approval cleanup without blocking user uninstalls", async () => {
  const project = await activateCommand("project", "trust-local")
  const user = await activateCommand("user", "trust-user")
  const saved = await readFile(project.approvedFile, "utf8")
  await forgetTrusted(root)
  try {
    for (const entry of [project, user]) await rm(entry.folder, { recursive: true })
    const { removed, failures } = await plugins.removeDeleted(() => true)
    expect(removed).not.toContain("project:trust-local")
    expect(removed).toContain("user:trust-user")
    expect(failures).toEqual([])
    expect(await readFile(project.approvedFile, "utf8")).toBe(saved)
    expect(await Bun.file(user.approvedFile).exists()).toBe(false)
  } finally {
    await rememberTrusted(root)
  }
  expect((await plugins.removeDeleted(() => true)).removed).toContain("project:trust-local")
  expect(await Bun.file(project.approvedFile).exists()).toBe(false)
})

test("revoking trust between idle checks preserves the approval and its unresolved cleanup error", async () => {
  const project = await activateCommand("project", "trust-probe")
  const previous = await readFile(project.approvedFile, "utf8")
  await rm(project.folder, { recursive: true })
  await writeFile(project.folder, "not a directory")
  const failed = await plugins.removeDeleted(() => true)
  expect(failed.failures).toContainEqual(expect.stringContaining(project.folder))
  await rm(project.folder)
  const probe = revokeAfterNextTrustRead()
  try {
    const { removed, failures } = await plugins.removeDeleted(() => true)
    expect(await isTrusted(root)).toBe(false)
    expect(failures).toEqual(failed.failures)
    expect(removed).not.toContain("project:trust-probe")
    expect(getCommand(project.name)).toBeDefined()
    expect(await readFile(project.approvedFile, "utf8")).toBe(previous)
  } finally {
    probe.mockRestore()
    await rememberTrusted(root)
  }
  expect(await plugins.removeDeleted(() => true)).toMatchObject({
    removed: expect.arrayContaining(["project:trust-probe"]),
    failures: [],
  })
})

test("startup cannot remove a project approval after an earlier plugin revokes trust", async () => {
  const trigger = join(root, "revoke-on-restore")
  const trust = JSON.stringify(join(agentHome(), "trust.json"))
  const name = "a-revoke-trust"
  const revoke = `if (existsSync(${JSON.stringify(trigger)})) {
    const trusted = JSON.parse(readFileSync(${trust}, "utf8"));
    writeFileSync(${trust}, JSON.stringify(trusted.filter(p => p !== ${JSON.stringify(root)})));
  }`
  const source = `import {existsSync, readFileSync, writeFileSync} from "node:fs";\n${commandPlugin(name, "revoke-alias", revoke)}`
  const revoker = await draft("project", name, source)
  await plugins.activate("project", name, revoker.sha256, root, signal)
  const target = await activateCommand("project", "z-trust-target")
  const previous = await readFile(target.approvedFile, "utf8")
  await rm(target.folder, { recursive: true })
  await writeFile(trigger, "")
  try {
    const result = await restart(root)
    expect(await isTrusted(root)).toBe(false)
    expect(result).not.toHaveProperty(`commands.${target.name}`)
    expect(await readFile(target.approvedFile, "utf8")).toBe(previous)
  } finally {
    await rm(trigger)
    await rememberTrusted(root)
  }
  expect((await plugins.removeDeleted(() => true)).removed).toContain("project:z-trust-target")
})

test("reports a malformed user approval directory at startup", async () => {
  const home = join(agentHome(), "malformed-home")
  const store = join(home, "approved-plugins", "user")
  await mkdir(dirname(store), { recursive: true })
  await writeFile(store, "not a directory")
  expect(await restart(root, home)).toMatchObject({ failures: [{ plugin: store, phase: "bootstrap" }] })
})
