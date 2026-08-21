import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { projectConfigPath } from "./paths"
import { loadSettings, saveSettings, settings } from "./settings"

interface SettingsEnvironment {
  home: string
  project: string
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function withSettingsEnvironment(run: (environment: SettingsEnvironment) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-settings-test-`))
  const home = join(directory, "home")
  const project = join(directory, "project")
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  const inheritedCwd = process.cwd()
  await mkdir(home, { recursive: true })
  await mkdir(join(project, ".git"), { recursive: true })
  process.env[homeEnv] = home
  process.chdir(project)
  try {
    await run({ home, project: process.cwd() })
  } finally {
    process.chdir(inheritedCwd)
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(directory, { recursive: true, force: true })
  }
}

test("trusted project settings override user settings with recursive object merging", async () => {
  await withSettingsEnvironment(async ({ home, project }) => {
    await writeJson(join(home, "config.json"), {
      plugins: ["user-plugin"],
      provider: "user-provider",
      model: "user-model",
      mode: "normal",
      permissions: {
        allow: ["bash(git status*)"],
        deny: ["bash(rm *)"],
      },
      pluginConfig: {
        shared: {
          location: "user",
          nested: { user: true, collision: "user" },
        },
        userOnly: { enabled: true },
      },
      thinking: {
        provider: { shared: "low", userModel: "medium" },
      },
    })
    await writeJson(join(home, "trust.json"), [project])
    await writeJson(projectConfigPath(project), {
      plugins: ["project-plugin"],
      model: "project-model",
      mode: "plan",
      permissions: {
        allow: ["bash(git log*)"],
      },
      redaction: {
        environment: ["MY_PROJECT_TOKEN"],
      },
      pluginConfig: {
        shared: {
          location: "project",
          nested: { project: true, collision: "project" },
        },
        projectOnly: { enabled: true },
      },
      thinking: {
        provider: { shared: "high", projectModel: "xhigh" },
      },
    })

    expect(await loadSettings()).toEqual({
      plugins: ["project-plugin"],
      provider: "user-provider",
      model: "project-model",
      ui: undefined,
      mode: "plan",
      permissions: {
        allow: ["bash(git log*)"],
        ask: [],
        deny: ["bash(rm *)"],
      },
      modes: {},
      goal: { evaluatorModels: {} },
      agents: { maxConcurrent: 4, timeoutMinutes: 10, maxTurns: 24 },
      redaction: {
        values: [],
        environment: ["MY_PROJECT_TOKEN"],
      },
      pluginConfig: {
        shared: {
          location: "project",
          nested: { user: true, collision: "project", project: true },
        },
        userOnly: { enabled: true },
        projectOnly: { enabled: true },
      },
      thinking: {
        provider: { shared: "high", userModel: "medium", projectModel: "xhigh" },
      },
    })
  })
})

test("does not read malformed project settings until the project is trusted", async () => {
  await withSettingsEnvironment(async ({ home, project }) => {
    await writeJson(join(home, "config.json"), { provider: "user-provider" })
    const projectConfig = projectConfigPath(project)
    await mkdir(dirname(projectConfig), { recursive: true })
    await writeFile(projectConfig, "{malformed")

    expect(await loadSettings()).toEqual({
      plugins: [],
      provider: "user-provider",
      model: undefined,
      ui: undefined,
      mode: undefined,
      permissions: { allow: [], ask: [], deny: [] },
      modes: {},
      goal: { evaluatorModels: {} },
      agents: { maxConcurrent: 4, timeoutMinutes: 10, maxTurns: 24 },
      redaction: { values: [], environment: [] },
      pluginConfig: {},
      thinking: {},
    })

    await writeJson(join(home, "trust.json"), [project])

    await expect(loadSettings()).rejects.toThrow(`${projectConfig} is malformed — fix or delete it`)
  })
})

test("validates built-in and custom default modes", async () => {
  await withSettingsEnvironment(async ({ home }) => {
    const config = join(home, "config.json")
    await writeJson(config, {
      mode: "review",
      modes: { review: { base: "plan" } },
    })

    expect((await loadSettings()).mode).toBe("review")

    await writeJson(config, { mode: "unknown" })
    await expect(loadSettings()).rejects.toThrow("mode must be one of: normal, plan, yolo")

    await writeJson(config, { mode: 42 })
    await expect(loadSettings()).rejects.toThrow("mode must be a string")
  })
})

test("saves only user settings securely while retaining project overrides in memory", async () => {
  await withSettingsEnvironment(async ({ home, project }) => {
    const userConfig = join(home, "config.json")
    await writeJson(userConfig, {
      provider: "user-provider",
      pluginConfig: { userPlugin: { enabled: true } },
    })
    await writeJson(join(home, "trust.json"), [project])
    await writeJson(projectConfigPath(project), {
      provider: "project-provider",
      plugins: ["project-plugin"],
    })

    await saveSettings({ model: "selected-model" })

    const persisted: unknown = JSON.parse(await readFile(userConfig, "utf8"))
    expect(persisted).toEqual({
      provider: "user-provider",
      pluginConfig: { userPlugin: { enabled: true } },
      model: "selected-model",
    })
    expect(settings()).toEqual({
      plugins: ["project-plugin"],
      provider: "project-provider",
      model: "selected-model",
      ui: undefined,
      mode: undefined,
      permissions: { allow: [], ask: [], deny: [] },
      modes: {},
      goal: { evaluatorModels: {} },
      agents: { maxConcurrent: 4, timeoutMinutes: 10, maxTurns: 24 },
      redaction: { values: [], environment: [] },
      pluginConfig: { userPlugin: { enabled: true } },
      thinking: {},
    })
    expect((await stat(userConfig)).mode & 0o777).toBe(0o600)
  })
})

test("rejects permission and redaction settings that are not string arrays", async () => {
  await withSettingsEnvironment(async ({ home }) => {
    await writeJson(join(home, "config.json"), { redaction: { values: "secret" } })
    await expect(loadSettings()).rejects.toThrow("redaction.values must be an array of strings")

    await writeJson(join(home, "config.json"), { permissions: { deny: [42] } })
    await expect(loadSettings()).rejects.toThrow("permissions.deny must be an array of strings")
  })
})
