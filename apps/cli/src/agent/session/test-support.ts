import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../../app-info"
import type { JsonObject } from "../../lib/json"
import type { ModelCatalog, Provider, StreamEvent, StreamRequest, Usage, UserInput } from "../../providers/types"
import type { AgentEvent } from "../events"
import type { SessionKind } from "../types"
import type { OutputSchema } from "./output-contract"
import { runAgentTurn, type AgentRunOutcome } from "../run"

export type ProviderRound = (request: StreamRequest) => AsyncIterable<StreamEvent>
export type AgentSessionConstructor = typeof import("./session").AgentSession
export type AgentSession = InstanceType<AgentSessionConstructor>

export interface AgentSessionTestHarness {
  createSession(
    provider: Provider,
    options?: { cwd?: string; interactive?: boolean; kind?: SessionKind; outputSchema?: OutputSchema },
  ): AgentSession
  cleanup(): Promise<void>
}

export async function setupAgentSessionTests(prefix: string): Promise<AgentSessionTestHarness> {
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  const testHome = await mkdtemp(join(tmpdir(), `${appInfo.name}-${prefix}`))
  process.env[homeEnv] = testHome
  const cleanup = async (): Promise<void> => {
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(testHome, { recursive: true, force: true })
  }

  let AgentSessionClass: AgentSessionConstructor
  try {
    AgentSessionClass = (await import("./session")).AgentSession
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    createSession: (provider, options = {}) =>
      new AgentSessionClass({
        provider,
        profileId: "test-profile",
        model: "test-model",
        cwd: options.cwd,
        persist: false,
        interactive: options.interactive ?? false,
        kind: options.kind,
        outputSchema: options.outputSchema,
        trackUndoPrompts: false,
      }),
    cleanup,
  }
}

export function round(events: StreamEvent[], error?: Error): ProviderRound {
  return async function* () {
    for (const event of events) yield event
    if (error) throw error
  }
}

export function completedRound(text: string, usage?: Usage): ProviderRound {
  return round([
    { type: "text_delta", text },
    { type: "item_done", item: { type: "assistant_message", text } },
    { type: "done", usage },
  ])
}

export function toolRound(callId: string, name: string, args: JsonObject): ProviderRound {
  return round([{ type: "item_done", item: { type: "tool_call", callId, name, args } }, { type: "done" }])
}

export class ScriptedProvider implements Provider {
  readonly id = `test-${crypto.randomUUID()}`
  readonly name = "Scripted provider"
  readonly aliases: string[] = []
  readonly capabilities = { imageInput: false }
  readonly requests: StreamRequest[] = []
  private index = 0

  constructor(
    private readonly rounds: ProviderRound[],
    private readonly contextWindow?: number,
    private readonly autoCompactTokenLimit?: number,
  ) {}

  async listModels(): Promise<ModelCatalog> {
    return {
      models: [
        {
          id: "test-model",
          name: "Test model",
          contextWindow: this.contextWindow,
          autoCompactTokenLimit: this.autoCompactTokenLimit,
          inputModalities: ["text"],
        },
      ],
      source: "runtime",
    }
  }

  async defaultModel(): Promise<string> {
    return "test-model"
  }

  async *stream(_profileId: string, request: StreamRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request)
    const providerRound = this.rounds[this.index]
    this.index += 1
    if (!providerRound) throw new Error("scripted provider received an unexpected request")
    yield* providerRound(request)
  }
}

export async function runSettledTurn(
  session: AgentSession,
  input: UserInput,
  handle?: (event: AgentEvent) => void,
): Promise<AgentRunOutcome> {
  let unsubscribe = (): void => {}
  const idle = new Promise<void>((resolve) => {
    unsubscribe = session.subscribe((event) => {
      if (event.type !== "state_changed" || event.state !== "idle") return
      unsubscribe()
      resolve()
    })
  })
  const outcome = await runAgentTurn(session, input, handle)
  if (session.currentState === "idle") {
    unsubscribe()
    return outcome
  }
  await idle
  return outcome
}
