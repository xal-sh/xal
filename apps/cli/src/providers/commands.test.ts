import { expect, test } from "bun:test"
import { getCommand } from "../commands/registry"
import type { CommandContext, SelectRequest } from "../commands/types"
import { loadSettings, settings } from "../config/settings"
import { setupAgentSessionTests } from "../agent/session/test-support"
import type { ModelCatalog, Provider, StreamEvent, StreamRequest } from "./types"
import { registerProviderCommands } from "./commands"

class BlockingProvider implements Provider {
  readonly id = `provider-command-${crypto.randomUUID()}`
  readonly name = "Provider command"
  readonly aliases: string[] = []
  readonly capabilities = { imageInput: false }

  constructor(
    private readonly contextWindow: number | null = 260_000,
    private readonly autoCompactTokenLimit?: number,
  ) {}

  async listModels(): Promise<ModelCatalog> {
    const contextWindow = this.contextWindow ?? undefined
    return {
      models: [
        {
          id: "canonical-model",
          name: "Test model",
          aliases: [{ id: "test-model" }],
          contextWindow,
          contextWindows: contextWindow === undefined ? undefined : [contextWindow, 400_000],
          autoCompactTokenLimit: this.autoCompactTokenLimit,
          inputModalities: ["text"],
        },
      ],
      source: "bundled",
    }
  }

  async defaultModel(): Promise<string> {
    return "test-model"
  }

  async *stream(_profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
    await new Promise<void>((resolve) => {
      if (!request.signal || request.signal.aborted) {
        resolve()
        return
      }
      request.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    yield { type: "done" }
  }
}

registerProviderCommands()

test("does not save a context window when a turn starts while selection is pending", async () => {
  const harness = await setupAgentSessionTests("context-window-command-")
  try {
    await loadSettings()
    const session = harness.createSession(new BlockingProvider())
    let contextWindowChanges = 0
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "context_window_changed") contextWindowChanges += 1
    })
    try {
      const printed: string[] = []
      const context = {
        session,
        print(line: string) {
          printed.push(line)
        },
        busy() {},
        async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
          expect(session.send({ text: "start turn", images: [] })).toBeTrue()
          return request.options.at(-1)?.value
        },
        restore() {},
        async ask(): Promise<string | undefined> {
          return undefined
        },
        async askSecret(): Promise<string | undefined> {
          return undefined
        },
      } satisfies CommandContext
      const command = getCommand("context-window")
      if (!command) throw new Error("context-window command was not registered")

      await command.run([], context)

      expect(settings().contextWindows).toEqual({})
      expect(contextWindowChanges).toBe(0)
      expect(printed).toEqual(["cannot change context window while a turn is running"])
    } finally {
      unsubscribe()
      session.interrupt()
    }
  } finally {
    await harness.cleanup()
  }
})

test("saves a canonical compaction limit and shows current and default choices", async () => {
  const harness = await setupAgentSessionTests("compaction-limit-command-")
  try {
    await loadSettings()
    const provider = new BlockingProvider(260_000, 195_000)
    const session = harness.createSession(provider)
    let optionValues: unknown[] = []
    let currentOption: { note?: string; active?: boolean } | undefined
    let defaultDetail: string | undefined
    const context = {
      session,
      print() {},
      busy() {},
      async select<T>(selection: SelectRequest<T>): Promise<T | undefined> {
        optionValues = selection.options.map((option) => option.value)
        currentOption = selection.options.find((option) => option.value === 195_000)
        defaultDetail = selection.options.find((option) => option.value === 208_000)?.detail
        return selection.options.find((option) => option.value === 156_000)?.value
      },
      restore() {},
      async ask(): Promise<string | undefined> {
        return undefined
      },
      async askSecret(): Promise<string | undefined> {
        return undefined
      },
    } satisfies CommandContext
    const command = getCommand("compaction-limit")
    if (!command) throw new Error("compaction-limit command was not registered")

    await command.run([], context)

    expect(optionValues).toEqual([130_000, 156_000, 182_000, 195_000, 208_000])
    expect(currentOption).toMatchObject({ note: "current", active: true })
    expect(defaultDetail).toContain("Xal default maximum")
    expect(settings().compactionLimits).toEqual({ [provider.id]: { "canonical-model": 156_000 } })
  } finally {
    await harness.cleanup()
  }
})

test("does not save a compaction limit when a turn starts while selection is pending", async () => {
  const harness = await setupAgentSessionTests("compaction-limit-busy-")
  try {
    await loadSettings()
    const provider = new BlockingProvider()
    const session = harness.createSession(provider)
    const printed: string[] = []
    const context = {
      session,
      print(line: string) {
        printed.push(line)
      },
      busy() {},
      async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
        expect(session.send({ text: "start turn", images: [] })).toBeTrue()
        return request.options[0]?.value
      },
      restore() {},
      async ask(): Promise<string | undefined> {
        return undefined
      },
      async askSecret(): Promise<string | undefined> {
        return undefined
      },
    } satisfies CommandContext
    const command = getCommand("compaction-limit")
    if (!command) throw new Error("compaction-limit command was not registered")

    try {
      await command.run([], context)
      expect(settings().compactionLimits).toEqual({})
      expect(printed).toEqual(["cannot change compaction limit while a turn is running"])
    } finally {
      session.interrupt()
    }
  } finally {
    await harness.cleanup()
  }
})

test("does not save a compaction limit when the active model changes during selection", async () => {
  const harness = await setupAgentSessionTests("compaction-limit-model-change-")
  try {
    await loadSettings()
    const provider = new BlockingProvider()
    const session = harness.createSession(provider)
    const printed: string[] = []
    const context = {
      session,
      print(line: string) {
        printed.push(line)
      },
      busy() {},
      async select<T>(request: SelectRequest<T>): Promise<T | undefined> {
        expect(session.setModel("test-profile", provider, "other-model")).toBeTrue()
        return request.options[0]?.value
      },
      restore() {},
      async ask(): Promise<string | undefined> {
        return undefined
      },
      async askSecret(): Promise<string | undefined> {
        return undefined
      },
    } satisfies CommandContext
    const command = getCommand("compaction-limit")
    if (!command) throw new Error("compaction-limit command was not registered")

    await command.run([], context)

    expect(settings().compactionLimits).toEqual({})
    expect(printed).toEqual(["active model changed; run /compaction-limit again"])
  } finally {
    await harness.cleanup()
  }
})

test("reports unavailable compaction limits when the context window is unknown", async () => {
  const harness = await setupAgentSessionTests("compaction-limit-unavailable-")
  try {
    await loadSettings()
    const provider = new BlockingProvider(null)
    const session = harness.createSession(provider)
    const printed: string[] = []
    const context = {
      session,
      print(line: string) {
        printed.push(line)
      },
      busy() {},
      async select<T>(): Promise<T | undefined> {
        throw new Error("selector should not open")
      },
      restore() {},
      async ask(): Promise<string | undefined> {
        return undefined
      },
      async askSecret(): Promise<string | undefined> {
        return undefined
      },
    } satisfies CommandContext
    const command = getCommand("compaction-limit")
    if (!command) throw new Error("compaction-limit command was not registered")

    await command.run([], context)

    expect(settings().compactionLimits).toEqual({})
    expect(printed).toEqual(["test-model does not have a known context window; compaction limits are unavailable"])
  } finally {
    await harness.cleanup()
  }
})
