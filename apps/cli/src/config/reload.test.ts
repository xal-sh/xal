import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import * as os from "node:os"
import { dirname, join } from "node:path"
import { composeSystemPrompt } from "../agent/prompt/registry"
import { taskScheduler } from "../agent/task/spawn"
import { appEnvVar } from "../app-info"
import { events, type AppEvent } from "../events"
import { isDenied, setUserRules } from "../permissions/rules"
import { registerRedaction } from "../secrets/register"
import { redactText } from "../secrets/redactor"
import { expandSkillInvocation } from "../skills/invoke"
import { discoverSkills, registerSkills } from "../skills/register"
import { getSkill, listSkills, replaceSkills } from "../skills/registry"
import { renderSkill } from "../skills/tool"
import { projectConfigPath, userConfigPath } from "./paths"
import { RuntimeReloader } from "./reload"
import { loadSettings, replaceSettings, saveProviderModelNumber, saveSettings, settings } from "./settings"

registerSkills()

interface ReloadEnvironment {
  home: string
  userHome: string
  project: string
  reloader: RuntimeReloader
  notices: Extract<AppEvent, { type: "runtime_reload" }>[]
  setIdle(idle: boolean): void
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function writeSkill(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`)
}

async function withEnvironment(run: (environment: ReloadEnvironment) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "xal-reload-"))
  const home = join(directory, "app-home")
  const userHome = join(directory, "user-home")
  const inheritedCwd = process.cwd()
  const mockHome = spyOn(os, "homedir").mockReturnValue(userHome)
  const homeEnv = appEnvVar("HOME")
  const inheritedAppHome = process.env[homeEnv]
  const previous = settings()
  const previousSkills = listSkills()
  await mkdir(home)
  await mkdir(userHome)
  await mkdir(join(directory, "project", ".git"), { recursive: true })
  process.chdir(join(directory, "project"))
  process.env[homeEnv] = home
  let idle = true
  const notices: ReloadEnvironment["notices"] = []
  const unsubscribe = events.subscribe((event) => {
    if (event.type === "runtime_reload") notices.push(event)
  })
  const reloader = new RuntimeReloader(process.cwd(), () => idle)
  try {
    expect(homedir()).toBe(userHome)
    await loadSettings()
    await discoverSkills()
    setUserRules(settings().permissions)
    registerRedaction(settings())
    await run({ home, userHome, project: process.cwd(), reloader, notices, setIdle: (value) => (idle = value) })
  } finally {
    await reloader.stop()
    unsubscribe()
    replaceSettings(previous)
    replaceSkills(previousSkills)
    setUserRules(previous.permissions)
    registerRedaction(previous)
    process.chdir(inheritedCwd)
    mockHome.mockRestore()
    if (inheritedAppHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedAppHome
    await rm(directory, { recursive: true, force: true })
  }
}

test("reloads new skill roots, project overrides, edits, renames, symlinks and deletions for every consumer", async () => {
  await withEnvironment(async ({ home, userHome, project, reloader, notices }) => {
    await writeJson(join(home, "trust.json"), [project])
    const global = join(userHome, ".agents", "skills", "review")
    const user = join(home, "skills", "review")
    const shared = join(project, ".agents", "skills", "review")
    const local = join(dirname(projectConfigPath(project)), "skills", "review")
    await writeSkill(global, "review", "global guidance")
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("global guidance")
    await writeSkill(user, "review", "user guidance")
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("user guidance")
    await writeSkill(shared, "review", "shared project guidance")
    await writeSkill(local, "review", "local guidance")
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("local guidance")
    expect(await expandSkillInvocation("$review inspect")).toContain("local guidance")
    expect(await renderSkill(getSkill("review")!)).toContain("local guidance")
    expect(
      composeSystemPrompt({
        sessionId: "reload-test",
        appName: "xal",
        platform: process.platform,
        cwd: project,
        kind: "primary",
        tools: [],
        mode: "normal",
      }),
    ).toContain("- review: local guidance")

    await writeSkill(local, "audit", "updated guidance")
    await reloader.refresh()
    expect(getSkill("audit")?.body).toBe("updated guidance")
    expect(getSkill("review")?.body).toBe("shared project guidance")
    await rm(local, { recursive: true })
    await rm(shared, { recursive: true })
    await rm(user, { recursive: true })
    await reloader.refresh()
    expect(getSkill("audit")).toBeUndefined()
    expect(getSkill("review")?.body).toBe("global guidance")

    const linked = join(home, "linked-package")
    await writeSkill(linked, "linked", "first linked guidance")
    await symlink(linked, join(home, "skills", "linked"))
    await reloader.refresh()
    await writeSkill(linked, "linked", "updated linked guidance")
    await reloader.refresh()
    expect(getSkill("linked")?.body).toBe("updated linked guidance")
    await rm(global, { recursive: true })
    await reloader.refresh()
    expect(getSkill("review")).toBeUndefined()
    const count = notices.length
    await reloader.refresh()
    expect(notices).toHaveLength(count)
  })
})

test("applies merged runtime settings and policies without writing files or activating startup settings", async () => {
  await withEnvironment(async ({ home, project, reloader, notices }) => {
    await writeJson(join(home, "trust.json"), [project])
    await writeJson(userConfigPath(), {
      providerTimeouts: { idleMs: 10_000 },
      permissions: { deny: ["bash(rm *)"] },
      redaction: { values: ["reload-secret"] },
      plugins: ["unloaded-plugin"],
      pluginConfig: { mcp: { servers: {} } },
      mode: "plan",
      model: "new-default",
    })
    const local = projectConfigPath(project)
    await writeJson(`${local}.tmp`, { providerTimeouts: { idleMs: 20_000 } })
    await rename(`${local}.tmp`, local)
    await reloader.refresh()
    expect(settings().providerTimeouts).toEqual({ firstEventMs: 600_000, idleMs: 20_000 })
    expect(settings().model).toBe("new-default")
    expect(settings().plugins).toEqual([])
    expect(settings().pluginConfig).toEqual({})
    expect(settings().mode).toBeUndefined()
    expect(redactText("a reload-secret value")).toBe("a [REDACTED] value")
    expect(
      isDenied({
        sessionKey: {},
        cwd: project,
        tool: "bash",
        title: "remove",
        args: {},
        subject: "rm file",
        readOnly: false,
        sandboxed: false,
        mode: "normal",
      }),
    ).toBe(true)
    expect(notices.filter((notice) => notice.outcome === "restart_required")).toHaveLength(1)
    await reloader.refresh()
    expect(notices.filter((notice) => notice.outcome === "restart_required")).toHaveLength(1)
    expect(await readFile(local, "utf8")).toBe(JSON.stringify({ providerTimeouts: { idleMs: 20_000 } }))
    await rm(local)
    await reloader.refresh()
    expect(settings().providerTimeouts.idleMs).toBe(10_000)
    await rm(userConfigPath())
    await reloader.refresh()
    expect(settings().providerTimeouts.idleMs).toBe(300_000)
    expect(redactText("reload-secret")).toBe("reload-secret")
  })
})

test("retains valid state on invalid edits, reports errors once, and recovers each source independently", async () => {
  await withEnvironment(async ({ home, reloader, notices }) => {
    const skill = join(home, "skills", "review")
    await writeSkill(skill, "review", "valid guidance")
    await reloader.refresh()
    await writeFile(userConfigPath(), "{invalid")
    await writeSkill(skill, "review", "new guidance")
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("new guidance")
    expect(settings().providerTimeouts.idleMs).toBe(300_000)
    await reloader.refresh()
    expect(notices.filter((notice) => notice.source === "settings" && notice.outcome === "error")).toHaveLength(1)
    expect(await readFile(userConfigPath(), "utf8")).toBe("{invalid")

    await writeJson(userConfigPath(), { providerTimeouts: { idleMs: 30_000 } })
    await writeFile(join(skill, "SKILL.md"), "incomplete frontmatter")
    await reloader.refresh()
    expect(settings().providerTimeouts.idleMs).toBe(30_000)
    expect(getSkill("review")?.body).toBe("new guidance")
    await reloader.refresh()
    expect(notices.filter((notice) => notice.source === "skills" && notice.outcome === "error")).toHaveLength(1)
    await writeSkill(skill, "review", "repaired guidance")
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("repaired guidance")
    expect(notices.at(-1)?.outcome).toBe("reloaded")
  })
})

test("ignores untrusted project files and picks them up only after trust is granted", async () => {
  await withEnvironment(async ({ home, project, reloader }) => {
    await writeJson(projectConfigPath(project), { providerTimeouts: { idleMs: 15_000 } })
    await writeSkill(join(project, ".agents", "skills", "review"), "review", "trusted guidance")
    await reloader.refresh()
    expect(getSkill("review")).toBeUndefined()
    expect(settings().providerTimeouts.idleMs).toBe(300_000)
    await writeJson(join(home, "trust.json"), [project])
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("trusted guidance")
    expect(settings().providerTimeouts.idleMs).toBe(15_000)
    await writeJson(join(home, "trust.json"), [])
    await reloader.refresh()
    expect(getSkill("review")).toBeUndefined()
    expect(settings().providerTimeouts.idleMs).toBe(300_000)
  })
})

test("defers while busy, rejects reads raced by activity or settings changes, and drains on shutdown", async () => {
  await withEnvironment(async ({ home, reloader, setIdle, notices }) => {
    await writeJson(userConfigPath(), { model: "from-disk" })
    await writeSkill(join(home, "skills", "review"), "review", "guidance")
    setIdle(false)
    await reloader.refresh()
    expect(notices).toHaveLength(0)
    setIdle(true)
    const interrupted = reloader.refresh()
    expect(reloader.refresh()).toBe(interrupted)
    setIdle(false)
    await interrupted
    expect(notices).toHaveLength(0)
    setIdle(true)
    const outdated = reloader.refresh()
    replaceSettings({ ...settings(), model: "newer-choice" })
    await outdated
    expect(settings().model).toBe("newer-choice")
    expect(notices).toHaveLength(0)
    await reloader.refresh()
    expect(settings().model).toBe("from-disk")
    expect(getSkill("review")).toBeDefined()
    await writeSkill(join(home, "skills", "review"), "review", "too late")
    const stopped = reloader.refresh()
    await reloader.stop()
    await stopped
    await reloader.refresh()
    expect(getSkill("review")?.body).toBe("guidance")
  })
})

test("in-app saves publish only edited paths and cannot mask external policy or startup changes", async () => {
  await withEnvironment(async ({ project, reloader, notices, setIdle }) => {
    await writeJson(userConfigPath(), {
      permissions: { deny: ["bash(rm *)"] },
      redaction: { values: ["reload-secret"] },
      plugins: ["not-loaded"],
      mode: "plan",
      pluginConfig: { tui: { keybindings: { "app.exit": "ctrl+x" } } },
    })
    setIdle(false)
    await saveSettings({ model: "selected-model" })
    await saveProviderModelNumber("contextWindows", "test", "test-model", 100_000)
    await saveSettings({ pluginConfig: { tui: { showThinking: true } } })
    expect(settings().model).toBe("selected-model")
    expect(settings().contextWindows).toEqual({ test: { "test-model": 100_000 } })
    expect(settings().permissions.deny).toEqual([])
    expect(settings().plugins).toEqual([])
    expect(settings().mode).toBeUndefined()
    expect(settings().pluginConfig).toEqual({ tui: { showThinking: true } })
    await reloader.refresh()
    expect(redactText("reload-secret")).toBe("reload-secret")
    setIdle(true)
    await reloader.refresh()
    expect(settings().plugins).toEqual([])
    expect(settings().mode).toBeUndefined()
    expect(settings().pluginConfig).toEqual({ tui: { showThinking: true } })
    expect(redactText("reload-secret")).toBe("[REDACTED]")
    expect(
      isDenied({
        sessionKey: {},
        cwd: project,
        tool: "bash",
        title: "remove",
        args: {},
        subject: "rm file",
        readOnly: false,
        sandboxed: false,
        mode: "normal",
      }),
    ).toBe(true)
    expect(notices.find((notice) => notice.outcome === "restart_required")?.message).toContain(
      "plugins, mode, pluginConfig",
    )
  })
})

test("keeps the captured project scope when a nested repository changes root discovery", async () => {
  await withEnvironment(async ({ home, project, reloader }) => {
    await writeJson(join(home, "trust.json"), [project])
    await writeJson(projectConfigPath(project), { model: "project-model", permissions: { deny: ["bash(rm *)"] } })
    await writeSkill(join(project, ".agents", "skills", "review"), "review", "original project")
    await reloader.refresh()
    const nested = join(project, "nested")
    await mkdir(join(nested, ".git"), { recursive: true })
    process.chdir(nested)
    await reloader.refresh()
    await saveSettings({ model: "user-model" })
    expect(settings().model).toBe("project-model")
    expect(settings().permissions.deny).toEqual(["bash(rm *)"])
    expect(getSkill("review")?.body).toBe("original project")
  })
})

test("an initialized task scheduler uses the reloaded concurrency limit for the next batch", async () => {
  await withEnvironment(async ({ reloader }) => {
    const scheduler = taskScheduler()
    const abort = new AbortController()
    await scheduler.acquire(abort.signal)
    scheduler.release()
    await writeJson(userConfigPath(), { agents: { maxConcurrent: 1 } })
    await reloader.refresh()
    let acquired = 0
    const pending = [
      scheduler.acquire(abort.signal).then(() => {
        acquired += 1
        scheduler.release()
      }),
      scheduler.acquire(abort.signal).then(() => {
        acquired += 1
        scheduler.release()
      }),
    ]
    await Promise.resolve()
    expect(acquired).toBe(1)
    await Promise.all(pending)
    expect(acquired).toBe(2)
    await writeJson(userConfigPath(), { agents: { maxConcurrent: 2 } })
    await reloader.refresh()
    acquired = 0
    const next = [scheduler.acquire(abort.signal), scheduler.acquire(abort.signal)].map(async (ready) => {
      await ready
      acquired += 1
      scheduler.release()
    })
    await Promise.resolve()
    expect(acquired).toBe(2)
    await Promise.all(next)
  })
})

test("automatically discovers additions without an explicit refresh", async () => {
  await withEnvironment(async ({ home, reloader }) => {
    reloader.start()
    await writeSkill(join(home, "skills", "automatic"), "automatic", "automatic guidance")
    const deadline = Date.now() + 4_000
    while (!getSkill("automatic") && Date.now() < deadline) await Bun.sleep(25)
    expect(getSkill("automatic")?.body).toBe("automatic guidance")
  })
})
