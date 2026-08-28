import { expect, test } from "bun:test"
import { getCommand } from "../commands/registry"
import type { CommandContext, SelectRequest } from "../commands/types"
import { loadSettings, settings } from "../config/settings"
import { setupAgentSessionTests } from "../agent/session/test-support"
import type { ModelCatalog, Provider, StreamEvent, StreamRequest } from "./types"
import { registerProviderCommands } from "./commands"

class BlockingProvider implements Provider {
  readonly id = "context-window-command"
  readonly name = "Context window command"
  readonly aliases: string[] = []
  readonly capabilities = { imageInput: false }

  async listModels(): Promise<ModelCatalog> {
    return {
      models: [
        {
          id: "test-model",
          name: "Test model",
          contextWindow: 260_000,
          contextWindows: [260_000, 400_000],
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
