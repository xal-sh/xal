import { beforeEach, describe, expect, mock, test } from "bun:test"
import { resolveCli } from "../cli/registry"
import type { Settings } from "../config/settings"
import { events, type AppEvent } from "../events"
import { listHooks } from "../hooks/registry"
import { getTool } from "../tools/registry"
import type { Plugin } from "./types"

const builtinPlugins: Plugin[] = []
const importedPlugins = new Map<string, Plugin | Error>()

mock.module("./builtins", () => ({ builtinPlugins }))
mock.module("./load", () => ({
  async importPlugin(spec: string): Promise<Plugin> {
    const plugin = importedPlugins.get(spec)
    if (!plugin) throw new Error(`missing test plugin: ${spec}`)
    if (plugin instanceof Error) throw plugin
    return plugin
  },
}))

const { bootstrapPlugins, registerBootstrapStep, registerPlugins, shutdownPlugins } = await import("./discover")

function settings(plugins: string[] = [], pluginConfig: Settings["pluginConfig"] = {}): Settings {
  return {
    plugins,
    permissions: { allow: [], ask: [], deny: [] },
    modes: {},
    goal: { evaluatorModels: {} },
    redaction: { values: [], environment: [] },
    agents: { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 },
    pluginConfig,
    thinking: {},
    contextWindows: {},
    compactionLimits: {},
  }
}

function latch(): { promise: Promise<void>; release(): void } {
  let release = (): void => {
    throw new Error("latch released before initialization")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  builtinPlugins.length = 0
  importedPlugins.clear()
})

describe("plugin orchestration", () => {
  test("isolates registration failures and reports the complete status", async () => {
    const registered: string[] = []
    const observed: AppEvent[] = []
    const unsubscribe = events.subscribe((event) => observed.push(event))
    importedPlugins.set("broken", {
      name: "broken-plugin",
      register(ctx) {
        registered.push("broken")
        ctx.registerHook({ name: "partial", prompt: async () => undefined })
        ctx.registerTool({
          name: "partial-tool",
          description: "",
          parameters: { type: "object", properties: {} },
          title: () => "",
          execute: async () => ({ output: "" }),
        })
        throw new Error("registration exploded")
      },
    })
    importedPlugins.set("working", {
      name: "working-plugin",
      register(ctx) {
        registered.push(`working:${String(ctx.config.enabled)}`)
        ctx.registerHook({ name: "active", prompt: async () => undefined })
      },
    })

    try {
      const status = await registerPlugins(settings(["broken", "working"], { "working-plugin": { enabled: true } }))

      expect(status).toEqual({
        total: 2,
        failures: [{ plugin: "broken", phase: "register", reason: "registration exploded" }],
        notices: [],
      })
      expect(registered).toEqual(["broken", "working:true"])
      expect(listHooks()).toEqual([{ id: "working-plugin/active", events: ["prompt"] }])
      expect(getTool("partial-tool")).toBeUndefined()
      expect(observed).toEqual([{ type: "plugin_registration_finished", status }])
    } finally {
      unsubscribe()
    }
  })

  test("preflights secrets before committing plugin contributions", async () => {
    importedPlugins.set("invalid-secrets", {
      name: "invalid-secrets",
      register(ctx) {
        ctx.registerCli({ name: "invalid-secrets-cli", describe: "must not survive failed registration" })
        ctx.registerSecrets([
          `[REDACTED]<hidden>***•••_${String.fromCharCode(
            ...Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, index) => 0xe000 + index),
          )}`,
        ])
      },
    })

    const status = await registerPlugins(settings(["invalid-secrets"]))

    expect(status).toEqual({
      total: 1,
      failures: [{ plugin: "invalid-secrets", phase: "register", reason: "secret redaction marker resolution failed" }],
      notices: [],
    })
    expect(resolveCli(["invalid-secrets-cli"])).toBeUndefined()
  })

  test("runs bootstrap once for concurrent callers and accumulates lifecycle failures", async () => {
    const gate = latch()
    const entered: string[] = []
    const observed: AppEvent[] = []
    const unsubscribe = events.subscribe((event) => observed.push(event))
    importedPlugins.set("register-failure", new Error("could not import"))
    importedPlugins.set("bootstrap-failure", {
      name: "bootstrap-failure",
      register() {},
      async bootstrap() {
        entered.push("failure")
        await gate.promise
        throw new Error("bootstrap exploded")
      },
    })
    importedPlugins.set("bootstrap-success", {
      name: "bootstrap-success",
      register() {},
      async bootstrap() {
        entered.push("success")
        await gate.promise
      },
    })

    try {
      const registered = await registerPlugins(settings(["register-failure", "bootstrap-failure", "bootstrap-success"]))
      const first = bootstrapPlugins()
      const second = bootstrapPlugins()

      expect(first).toBe(second)
      await Promise.resolve()
      expect(entered).toEqual(["failure", "success"])
      gate.release()

      const status = await first
      expect(status).toEqual({
        total: 3,
        failures: [
          { plugin: "register-failure", phase: "register", reason: "could not import" },
          { plugin: "bootstrap-failure", phase: "bootstrap", reason: "bootstrap exploded" },
        ],
        notices: [],
      })
      expect(observed).toEqual([
        { type: "plugin_registration_finished", status: registered },
        { type: "plugin_bootstrap_started", total: 2 },
        { type: "plugin_bootstrap_finished", status },
      ])
    } finally {
      gate.release()
      unsubscribe()
    }
  })

  test("aborts every context and shuts plugins down once in reverse order", async () => {
    const bootstrapEntered = latch()
    const bootstrapRelease = latch()
    const signals: AbortSignal[] = []
    const stopped: string[] = []
    const makePlugin = (name: string, bootstrap = false, failShutdown = false): Plugin => ({
      name,
      register(ctx) {
        signals.push(ctx.signal)
      },
      ...(bootstrap
        ? {
            async bootstrap() {
              bootstrapEntered.release()
              await bootstrapRelease.promise
            },
          }
        : {}),
      async shutdown(ctx) {
        expect(ctx.signal.aborted).toBe(true)
        stopped.push(name)
        if (failShutdown) throw new Error(`${name} shutdown exploded`)
      },
    })
    builtinPlugins.push(makePlugin("first", true), makePlugin("second", false, true), makePlugin("third"))

    await registerPlugins(settings())
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    const bootstrapping = bootstrapPlugins()
    await bootstrapEntered.promise

    const first = shutdownPlugins()
    const second = shutdownPlugins()

    expect(first).toBe(second)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(stopped).toEqual([])
    bootstrapRelease.release()
    await bootstrapping

    expect(await first).toEqual({
      total: 3,
      failures: [{ plugin: "second", phase: "shutdown", reason: "second shutdown exploded" }],
      notices: [],
    })
    expect(stopped).toEqual(["third", "second", "first"])
  })

  test("reports bootstrap step warnings without treating them as failures", async () => {
    registerBootstrapStep("skills", async () => ["invalid skill was skipped"])
    await registerPlugins(settings())

    expect(await bootstrapPlugins()).toEqual({
      total: 0,
      failures: [],
      notices: [{ plugin: "skills", reason: "invalid skill was skipped" }],
    })
  })
})
