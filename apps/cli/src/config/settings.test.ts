import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { clearModelCatalog, findModel } from "../providers/catalog"
import type { Provider } from "../providers/types"
import { saveCompactionLimit } from "./compaction-limit"
import { saveContextWindow } from "./context-window"
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
      contextWindows: {
        provider: { shared: 400_000, userModel: 600_000 },
      },
      compactionLimits: {
        provider: { shared: 300_000, userModel: 450_000 },
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
      contextWindows: {
        provider: { shared: 800_000, projectModel: 1_000_000 },
      },
      compactionLimits: {
        provider: { shared: 600_000, projectModel: 750_000 },
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
      agents: { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 },
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
      contextWindows: {
        provider: { shared: 800_000, userModel: 600_000, projectModel: 1_000_000 },
      },
      compactionLimits: {
        provider: { shared: 600_000, userModel: 450_000, projectModel: 750_000 },
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
      agents: { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 },
      redaction: { values: [], environment: [] },
      pluginConfig: {},
      thinking: {},
      contextWindows: {},
      compactionLimits: {},
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
      agents: { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 },
      redaction: { values: [], environment: [] },
      pluginConfig: { userPlugin: { enabled: true } },
      thinking: {},
      contextWindows: {},
      compactionLimits: {},
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

test("accepts a disabled task-agent runtime limit and rejects negative values", async () => {
  await withSettingsEnvironment(async ({ home }) => {
    const config = join(home, "config.json")
    await writeJson(config, { agents: { timeoutMinutes: 0 } })

    expect((await loadSettings()).agents.timeoutMinutes).toBe(0)

    await writeJson(config, { agents: { timeoutMinutes: -1 } })
    await expect(loadSettings()).rejects.toThrow("agents.timeoutMinutes must be an integer between 0 and 60")
  })
})

test("rejects malformed context-window settings", async () => {
  await withSettingsEnvironment(async ({ home }) => {
    const config = join(home, "config.json")

    await writeJson(config, { contextWindows: "large" })
    await expect(loadSettings()).rejects.toThrow("contextWindows must be an object")

    await writeJson(config, { contextWindows: { openai: "large" } })
    await expect(loadSettings()).rejects.toThrow("contextWindows.openai must be an object")

    await writeJson(config, { contextWindows: { openai: { "gpt-5.6-sol": 600_000.5 } } })
    await expect(loadSettings()).rejects.toThrow("contextWindows.openai.gpt-5.6-sol must be a positive integer")
  })
})

test("rejects malformed compaction-limit settings", async () => {
  await withSettingsEnvironment(async ({ home }) => {
    const config = join(home, "config.json")

    await writeJson(config, { compactionLimits: "early" })
    await expect(loadSettings()).rejects.toThrow("compactionLimits must be an object")

    await writeJson(config, { compactionLimits: { openai: "early" } })
    await expect(loadSettings()).rejects.toThrow("compactionLimits.openai must be an object")

    for (const value of [0, -1, 200_000.5]) {
      await writeJson(config, { compactionLimits: { openai: { "gpt-5.6-sol": value } } })
      await expect(loadSettings()).rejects.toThrow("compactionLimits.openai.gpt-5.6-sol must be a positive integer")
    }
  })
})

test("saves canonical model limits without copying project-only values into user settings", async () => {
  await withSettingsEnvironment(async ({ home, project }) => {
    await writeJson(join(home, "config.json"), { plugins: ["user-plugin"] })
    await writeJson(join(home, "trust.json"), [project])
    await writeJson(projectConfigPath(project), {
      contextWindows: { "provider-a": { "project-model": 300_000 } },
      compactionLimits: { "provider-a": { "project-model": 200_000 } },
    })
    await loadSettings()
    const provider: Provider = {
      id: "provider-a",
      name: "Provider A",
      aliases: [],
      capabilities: { imageInput: false },
      async listModels() {
        return {
          models: [
            {
              id: "model-a",
              name: "Model A",
              aliases: [{ id: "model-a-large", contextWindow: 600_000 }],
              contextWindow: 260_000,
              contextWindows: [260_000, 400_000, 600_000],
              inputModalities: ["text"],
            },
          ],
          source: "bundled",
        }
      },
      async defaultModel() {
        return "model-a"
      },
      async *stream() {},
    }

    await saveContextWindow(provider, "model-a", 400_000)
    await saveCompactionLimit(provider, "model-a", 200_000)

    expect(settings().contextWindows).toEqual({
      "provider-a": { "model-a": 400_000, "project-model": 300_000 },
    })
    expect(settings().compactionLimits).toEqual({
      "provider-a": { "model-a": 200_000, "project-model": 200_000 },
    })
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({
      plugins: ["user-plugin"],
      contextWindows: { "provider-a": { "model-a": 400_000 } },
      compactionLimits: { "provider-a": { "model-a": 200_000 } },
    })
    expect(await findModel(provider, "profile-a", "model-a")).toMatchObject({
      id: "model-a",
      contextWindow: 400_000,
      autoCompactTokenLimit: 200_000,
    })
    expect(await findModel(provider, "profile-a", "model-a-large")).toMatchObject({
      id: "model-a",
      contextWindow: 400_000,
      autoCompactTokenLimit: 200_000,
    })
    clearModelCatalog("profile-a")
  })
})
