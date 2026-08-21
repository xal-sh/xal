import { appInfo } from "../../app-info"
import { describeError } from "../../lib/error"
import { asNumber, asString, isRecord } from "../../lib/json"
import { createNativeMcpManager, type NativeMcpManager } from "../../native"
import type { RegisteredTool, Tool } from "../../tools/types"
import type { McpServerConfig } from "./config"

export type McpConnectionTransport = "stdio" | "http" | "sse"
export type McpConnectionState = "disabled" | "idle" | "connecting" | "connected" | "failed"

export interface McpServerStatus {
  id: string
  configuredTransport: McpServerConfig["transport"]
  connectionTransport?: McpConnectionTransport
  state: McpConnectionState
  tools: number
  resources: number
  resourceTemplates: number
  prompts: number
  warning?: string
}

interface McpToolRegistry {
  register(tool: RegisteredTool): void
  unregister(tool: RegisteredTool): void
}

interface ToolDescriptor {
  name: string
  server: string
  remoteName: string
  description: string
  parameters: Record<string, unknown>
  title: string
}

interface ToolSnapshot {
  revision: number
  tools: ToolDescriptor[]
}

function searchTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
}

function searchScore(descriptor: ToolDescriptor, query: string, terms: string[]): number {
  const name = `${descriptor.server} ${descriptor.remoteName} ${descriptor.name}`.toLowerCase()
  const text = `${name} ${descriptor.description.toLowerCase()}`
  let score = text.includes(query) ? 100 : 0
  for (const term of terms) {
    if (name.includes(term)) score += 10
    else if (text.includes(term)) score += 1
  }
  return score
}

function requiredString(value: Record<string, unknown>, key: string, message: string): string {
  const output = asString(value[key])
  if (output === undefined || output.length === 0) throw new Error(message)
  return output
}

function count(value: unknown, message: string): number {
  const output = asNumber(value)
  if (output === undefined || !Number.isSafeInteger(output) || output < 0) throw new Error(message)
  return output
}

function isConnectionState(value: string): value is McpConnectionState {
  return (
    value === "disabled" || value === "idle" || value === "connecting" || value === "connected" || value === "failed"
  )
}

function isConnectionTransport(value: string): value is McpConnectionTransport {
  return value === "stdio" || value === "http" || value === "sse"
}

function parseStatus(value: unknown): McpServerStatus {
  if (!isRecord(value)) throw new Error("native MCP manager returned an invalid server status")
  const message = "native MCP manager returned an invalid server status"
  const configuredTransport = requiredString(value, "configuredTransport", message)
  const state = requiredString(value, "state", message)
  const connectionTransport = asString(value.connectionTransport)
  const warning = asString(value.warning)
  if (configuredTransport !== "stdio" && configuredTransport !== "http") throw new Error(message)
  if (!isConnectionState(state)) throw new Error(message)
  if (connectionTransport !== undefined && !isConnectionTransport(connectionTransport)) throw new Error(message)
  return {
    id: requiredString(value, "id", message),
    configuredTransport,
    ...(connectionTransport ? { connectionTransport } : {}),
    state,
    tools: count(value.tools, message),
    resources: count(value.resources, message),
    resourceTemplates: count(value.resourceTemplates, message),
    prompts: count(value.prompts, message),
    ...(warning ? { warning } : {}),
  }
}

function parseDescriptor(value: unknown): ToolDescriptor {
  if (!isRecord(value) || !isRecord(value.parameters)) {
    throw new Error("native MCP manager returned an invalid tool descriptor")
  }
  const message = "native MCP manager returned an invalid tool descriptor"
  return {
    name: requiredString(value, "name", message),
    server: requiredString(value, "server", message),
    remoteName: requiredString(value, "remoteName", message),
    description: requiredString(value, "description", message),
    parameters: value.parameters,
    title: requiredString(value, "title", message),
  }
}

function parseToolSnapshot(value: string): ToolSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error("native MCP manager returned invalid tool descriptor JSON", { cause: error })
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new Error("native MCP manager returned invalid tool descriptors")
  }
  const revision = count(parsed.revision, "native MCP manager returned invalid tool descriptors")
  const tools = parsed.tools.map(parseDescriptor)
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("native MCP manager returned duplicate tool descriptors")
  }
  return { revision, tools }
}

function parseServers(value: string): McpServerStatus[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error("native MCP manager returned invalid server JSON", { cause: error })
  }
  if (!Array.isArray(parsed)) throw new Error("native MCP manager returned invalid server JSON")
  return parsed.map(parseStatus)
}

export class McpManager {
  private readonly native: NativeMcpManager
  private registeredTools: RegisteredTool[] = []
  private descriptors: ToolDescriptor[] = []
  private readonly exposedTools = new Map<string, Set<string>>()
  private toolRevision = -1
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private refreshPromise: Promise<void> | undefined
  private refreshFailure: string | undefined
  private closed = false

  constructor(
    configs: McpServerConfig[],
    private readonly tools: McpToolRegistry,
  ) {
    this.native = createNativeMcpManager(configs, appInfo.name, appInfo.version)
  }

  async connectAll(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      await this.close()
      return
    }
    this.closed = false
    await this.native.connectAll(signal)
    this.syncTools()
    this.startRefresh()
  }

  async reconnect(server?: string): Promise<void> {
    this.closed = false
    await this.native.reconnect(server)
    this.syncTools()
    this.startRefresh()
  }

  async remove(server: string): Promise<void> {
    await this.native.remove(server)
    this.syncTools()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    await this.refreshPromise
    await this.native.close()
    this.syncTools()
  }

  hasTools(): boolean {
    return this.descriptors.length > 0
  }

  toolAvailable(sessionId: string, name: string): boolean {
    return this.exposedTools.get(sessionId)?.has(name) ?? false
  }

  searchTools(sessionId: string, query: string, limit: number): string {
    const normalized = query.trim().toLowerCase()
    const terms = searchTerms(normalized)
    if (terms.length === 0) throw new Error("query must not be empty")
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error("limit must be an integer from 1 to 20")

    const matches = this.descriptors
      .map((descriptor) => ({ descriptor, score: searchScore(descriptor, normalized, terms) }))
      .filter((match) => match.score > 0)
      .toSorted((left, right) => right.score - left.score || left.descriptor.name.localeCompare(right.descriptor.name))
      .slice(0, limit)
      .map((match) => match.descriptor)
    if (matches.length === 0) return "No matching MCP tools found."

    const exposed = this.exposedTools.get(sessionId) ?? new Set<string>()
    for (const descriptor of matches) exposed.add(descriptor.name)
    this.exposedTools.set(sessionId, exposed)
    return ["Loaded MCP tools for the next model call:", ...matches.map((descriptor) => `- ${descriptor.name}`)].join(
      "\n",
    )
  }

  disposeSession(sessionId: string): void {
    this.exposedTools.delete(sessionId)
  }

  hasResources(): boolean {
    return this.native.hasResources
  }

  hasPrompts(): boolean {
    return this.native.hasPrompts
  }

  servers(): McpServerStatus[] {
    const servers = parseServers(this.native.servers())
    if (!this.refreshFailure) return servers
    const [first, ...rest] = servers
    if (!first) return servers
    return [
      {
        ...first,
        warning: [first.warning, `catalog refresh: ${this.refreshFailure}`].filter(Boolean).join("; "),
      },
      ...rest,
    ]
  }

  statusLines(id?: string): string[] {
    const lines = this.native.statusLines(id)
    if (!this.refreshFailure || lines.length === 0) return lines
    return [`${lines[0]} · warning: catalog refresh: ${this.refreshFailure}`, ...lines.slice(1)]
  }

  prompt(): string {
    return this.native.prompt
  }

  resourceCatalog(server?: string): string {
    return this.native.resourceCatalog(server)
  }

  promptCatalog(server?: string): string {
    return this.native.promptCatalog(server)
  }

  readResource(server: string, uri: string, signal: AbortSignal): Promise<string> {
    return this.native.readResource(JSON.stringify({ server, uri }), signal)
  }

  getPrompt(
    server: string,
    name: string,
    args: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    return this.native.getPrompt(JSON.stringify({ server, name, arguments: args }), signal)
  }

  private startRefresh(): void {
    if (this.closed || this.refreshTimer) return
    this.refreshTimer = setInterval(() => void this.refreshCatalogs(), 250)
    this.refreshTimer.unref?.()
  }

  private async refreshCatalogs(): Promise<void> {
    if (this.closed) return
    if (this.refreshPromise) return this.refreshPromise
    const refresh = this.runRefresh()
    this.refreshPromise = refresh
    try {
      await refresh
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = undefined
    }
  }

  private async runRefresh(): Promise<void> {
    try {
      await this.native.refresh()
      if (this.closed) return
      this.syncTools()
      this.refreshFailure = undefined
    } catch (error) {
      if (!this.closed) this.refreshFailure = describeError(error)
    }
  }

  private syncTools(): void {
    const snapshot = parseToolSnapshot(this.native.toolDescriptors())
    if (snapshot.revision === this.toolRevision) return
    const next = snapshot.tools.map((descriptor) => this.tool(descriptor))
    const previous = this.registeredTools
    for (const tool of previous) this.tools.unregister(tool)
    const registered: RegisteredTool[] = []
    try {
      for (const tool of next) {
        this.tools.register(tool)
        registered.push(tool)
      }
    } catch (error) {
      for (const tool of registered) this.tools.unregister(tool)
      for (const tool of previous) this.tools.register(tool)
      this.registeredTools = previous
      throw error
    }
    this.registeredTools = next
    this.descriptors = snapshot.tools
    const names = new Set(snapshot.tools.map((descriptor) => descriptor.name))
    for (const [sessionId, exposed] of this.exposedTools) {
      const current = new Set([...exposed].filter((name) => names.has(name)))
      if (current.size > 0) this.exposedTools.set(sessionId, current)
      else this.exposedTools.delete(sessionId)
    }
    this.toolRevision = snapshot.revision
  }

  private tool(descriptor: ToolDescriptor): Tool {
    return {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
      available: (ctx) => this.toolAvailable(ctx.sessionId, descriptor.name),
      title: () => descriptor.title,
      undo: () => ({ type: "invalidate" }),
      permission: () => ({ subject: `${descriptor.server}/${descriptor.remoteName}`, suggestion: descriptor.name }),
      execute: async (args, ctx) => {
        const call = this.native.startToolCall(
          JSON.stringify({ server: descriptor.server, name: descriptor.remoteName, arguments: args }),
        )
        let progressFailure: unknown
        const drain = (async () => {
          while (true) {
            const progress = await call.nextProgress(ctx.signal)
            if (progress === undefined) return
            try {
              ctx.update(progress)
            } catch (error) {
              progressFailure ??= error
            }
          }
        })()
        let output: string
        try {
          output = await call.result(ctx.signal)
        } finally {
          await drain
        }
        if (progressFailure !== undefined) throw progressFailure
        return { output }
      },
    }
  }
}
