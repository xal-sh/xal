import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import type { RegisteredTool, Tool } from "../../tools/types"
import { McpManager } from "./manager"

const directories: string[] = []

class Registry {
  readonly tools = new Map<string, Tool>()
  rejectName: string | undefined

  register(tool: RegisteredTool): void {
    if ("interactive" in tool || "sessionAware" in tool) throw new Error("unexpected MCP tool type")
    if (tool.name === this.rejectName) throw new Error(`rejected ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  unregister(tool: RegisteredTool): void {
    this.tools.delete(tool.name)
  }
}

async function fakeServer(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xal-mcp-"))
  directories.push(directory)
  const path = join(directory, "server.ts")
  await writeFile(
    path,
    `
let buffer = ""
let toolVersion = 0
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }) }
function tools() {
  const base = [
    { name: "echo tool", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false } },
    { name: "task only", description: "Requires MCP tasks", inputSchema: { type: "object", additionalProperties: false }, execution: { taskSupport: "required" } },
  ]
  if (toolVersion > 0) base.push({ name: "added", description: "Added dynamically", inputSchema: { type: "object", additionalProperties: false } })
  return base
}
async function handle(message) {
  if (!Object.hasOwn(message, "id")) return
  const id = message.id
  if (message.method === "initialize") return result(id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" }, instructions: "Use fixture tools." })
  if (message.method === "tools/list") return result(id, { tools: tools() })
  if (message.method === "resources/list") {
    if (!message.params?.cursor) return result(id, { resources: [{ uri: "fixture://one", name: "One" }], nextCursor: "resource-next" })
    return result(id, { resources: [{ uri: "fixture://two", name: "Two" }] })
  }
  if (message.method === "resources/templates/list") return result(id, { resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "Fixture" }] })
  if (message.method === "prompts/list") return result(id, { prompts: [{ name: "hello", description: "Hello prompt", arguments: [{ name: "name", required: false }] }] })
  if (message.method === "resources/read") return result(id, { contents: [{ uri: message.params.uri, text: "resource text" }] })
  if (message.method === "prompts/get") return result(id, { description: "Greeting", messages: [{ role: "user", content: { type: "text", text: "Hello " + (message.params.arguments?.name ?? "world") } }] })
  if (message.method === "tools/call") {
    const token = message.params._meta?.progressToken ?? "xal-1"
    await Bun.sleep(10)
    for (let index = 1; index <= 40; index++) {
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: index, total: 40 } })
      await Bun.sleep(1)
    }
    await Bun.sleep(10)
    if (message.params.name === "echo tool") {
      toolVersion = 1
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      return result(id, { content: [{ type: "text", text: "echo complete" }], structuredContent: { echoed: message.params.arguments.value }, isError: false })
    }
    return result(id, { content: [{ type: "text", text: "added" }], isError: false })
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf("\\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) void handle(JSON.parse(line))
  }
})
`,
  )
  return path
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error("timed out waiting for MCP catalog refresh")
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("native MCP manager", () => {
  test("cancels HTTP connection setup", async () => {
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "POST") return new Response("legacy", { status: 405 })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(": waiting\n\n"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const manager = new McpManager(
      [
        {
          id: "slow",
          enabled: true,
          timeoutMs: 10_000,
          transport: "http",
          url: server.url.href,
          headers: {},
        },
      ],
      new Registry(),
    )
    const controller = new AbortController()
    try {
      const connection = manager.connectAll(controller.signal)
      await Bun.sleep(30)
      controller.abort()
      await connection
      expect(manager.statusLines()[0]).toBe("slow · idle")
    } finally {
      await manager.close()
      server.stop(true)
    }
  })

  test("connects over streamable HTTP", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const message: unknown = await request.json()
        if (!message || typeof message !== "object" || !("method" in message)) {
          return new Response("bad request", { status: 400 })
        }
        if (!("id" in message)) return new Response(null, { status: 202 })
        let result: unknown
        if (message.method === "initialize") {
          result = {
            protocolVersion:
              "params" in message &&
              message.params &&
              typeof message.params === "object" &&
              "protocolVersion" in message.params
                ? message.params.protocolVersion
                : "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "streamable", version: "1" },
          }
        } else if (message.method === "tools/list") {
          result = { tools: [] }
        } else {
          return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })
        }
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          { headers: { "mcp-session-id": "fixture-session" } },
        )
      },
    })
    const manager = new McpManager(
      [
        {
          id: "streamable",
          enabled: true,
          timeoutMs: 5_000,
          transport: "http",
          url: server.url.href,
          headers: {},
        },
      ],
      new Registry(),
    )
    try {
      await manager.connectAll()
      expect(manager.statusLines()[0]).toContain("streamable · connected (http)")
    } finally {
      await manager.close()
      server.stop(true)
    }
  })

  test("does not follow HTTP redirects with configured headers", async () => {
    let redirectedAuthorization: string | null | undefined
    const destination = Bun.serve({
      port: 0,
      fetch(request) {
        redirectedAuthorization = request.headers.get("authorization")
        return new Response("unexpected", { status: 500 })
      },
    })
    const source = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { location: destination.url.href },
        })
      },
    })
    const manager = new McpManager(
      [
        {
          id: "redirect",
          enabled: true,
          timeoutMs: 5_000,
          transport: "http",
          url: source.url.href,
          headers: { authorization: "Bearer fixture" },
        },
      ],
      new Registry(),
    )
    try {
      await manager.connectAll()
      expect(manager.statusLines()[0]).toContain("redirect · failed")
      expect(redirectedAuthorization).toBeUndefined()
    } finally {
      await manager.close()
      await source.stop(true)
      await destination.stop(true)
    }
  })

  test("falls back to legacy SSE when streamable HTTP is unavailable", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/sse" && request.method === "POST") return new Response("legacy", { status: 405 })
        if (url.pathname === "/sse" && request.method === "GET") {
          if (request.headers.get("authorization") !== "Bearer fixture")
            return new Response("unauthorized", { status: 401 })
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller
                controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (url.pathname === "/messages" && request.method === "POST") {
          const message: unknown = await request.json()
          if (!message || typeof message !== "object" || !("method" in message)) {
            return new Response("bad request", { status: 400 })
          }
          if (!("id" in message)) return new Response(null, { status: 202 })
          const id: unknown = message.id
          const method: unknown = message.method
          let value: unknown
          if (method === "initialize") {
            const params =
              "params" in message && message.params && typeof message.params === "object" ? message.params : {}
            const protocolVersion = "protocolVersion" in params ? params.protocolVersion : "2025-03-26"
            value = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } }
          } else if (method === "tools/list") {
            value = { tools: [] }
          } else {
            value = {}
          }
          stream?.enqueue(
            encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n\n`),
          )
          return new Response(null, { status: 202 })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const manager = new McpManager(
      [
        {
          id: "legacy",
          enabled: true,
          timeoutMs: 5_000,
          transport: "http",
          url: `http://127.0.0.1:${server.port}/sse`,
          headers: { authorization: "Bearer fixture" },
        },
      ],
      new Registry(),
    )
    try {
      await manager.connectAll()
      expect(manager.statusLines()[0]).toContain("legacy · connected (sse)")
    } finally {
      await manager.close()
      server.stop(true)
    }
  })

  test("restores registered tools when a catalog replacement fails", async () => {
    const server = await fakeServer()
    const registry = new Registry()
    const manager = new McpManager(
      [
        {
          id: "rollback",
          enabled: true,
          timeoutMs: 5_000,
          transport: "stdio",
          command: process.execPath,
          args: [server],
          env: {},
        },
      ],
      registry,
    )

    try {
      await manager.connectAll()
      const previousNames = [...registry.tools.keys()].sort()
      const tool = [...registry.tools.values()].find((candidate) => candidate.name.includes("echo_tool"))
      if (!tool) throw new Error("MCP tool was not registered")
      registry.rejectName = "mcp__rollback__added"
      await tool.execute(
        { value: "native" },
        {
          cwd: process.cwd(),
          sessionId: "session",
          sessionKind: "primary",
          directory: process.cwd(),
          signal: new AbortController().signal,
          update() {},
        },
      )

      await waitFor(() => manager.statusLines()[0]?.includes("rejected mcp__rollback__added") ?? false)
      expect([...registry.tools.keys()].sort()).toEqual(previousNames)
    } finally {
      await manager.close()
    }
  }, 15_000)

  test("owns stdio catalogs, dynamic tools, progress, resources, prompts, and shutdown", async () => {
    const server = await fakeServer()
    const registry = new Registry()
    const manager = new McpManager(
      [
        {
          id: "fixture",
          enabled: true,
          timeoutMs: 5_000,
          transport: "stdio",
          command: process.execPath,
          args: [server],
          env: {},
        },
      ],
      registry,
    )

    await manager.connectAll()
    expect(manager.statusLines()[0]).toContain(
      "fixture · connected (stdio) · 2 tools · 2 resources · 1 templates · 1 prompts",
    )
    expect([...registry.tools.keys()].some((name) => name.includes("task_only"))).toBe(true)
    const echoTool = [...registry.tools.values()].find((tool) => tool.name.includes("echo_tool"))
    if (!echoTool) throw new Error("echo MCP tool was not registered")
    expect(echoTool.available?.({ sessionId: "session", interactive: false, kind: "primary", mode: "normal" })).toBe(
      false,
    )
    const searchResult = manager.searchTools("session", "echo a value", 8)
    expect(searchResult).toContain(echoTool.name)
    expect(searchResult).not.toContain("inputSchema")
    expect(echoTool.available?.({ sessionId: "session", interactive: false, kind: "primary", mode: "normal" })).toBe(
      true,
    )
    expect(echoTool.available?.({ sessionId: "other", interactive: false, kind: "primary", mode: "normal" })).toBe(
      false,
    )
    expect(manager.prompt()).toContain("Use fixture tools.")
    expect(manager.resourceCatalog()).toContain("fixture://two")
    expect(manager.promptCatalog()).toContain("hello")

    const resource = await manager.readResource("fixture", "fixture://one", new AbortController().signal)
    expect(resource).toBe("[resource fixture://one]\nresource text")
    const prompt = await manager.getPrompt("fixture", "hello", { name: "Ada" }, new AbortController().signal)
    expect(prompt).toBe("Greeting\n\nuser:\nHello Ada")

    const tool = registry.tools.values().next().value
    if (!tool) throw new Error("MCP tool was not registered")
    const progress: string[] = []
    const output = await tool.execute(
      { value: "native" },
      {
        cwd: process.cwd(),
        sessionId: "session",
        sessionKind: "primary",
        directory: process.cwd(),
        signal: new AbortController().signal,
        update(text) {
          progress.push(text)
        },
      },
    )
    expect(output.output).toBe('echo complete\n\nStructured content:\n{\n  "echoed": "native"\n}')
    expect(progress).toHaveLength(40)
    expect(progress).toEqual(Array.from({ length: 40 }, (_, index) => `MCP progress ${index + 1}/40`))

    await waitFor(() => registry.tools.size === 3)
    expect([...registry.tools.keys()]).toContain("mcp__fixture__added")

    await manager.close()
    expect(registry.tools.size).toBe(0)
  }, 15_000)
})
