import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LspServerDefinition } from "./config"
import { LspManager } from "./manager"

const roots: string[] = []
const managers: LspManager[] = []

async function fixture(): Promise<{ root: string; definition: LspServerDefinition }> {
  const root = await mkdtemp(join(tmpdir(), "xal-lsp-"))
  roots.push(root)
  const server = join(root, "server.ts")
  await writeFile(
    server,
    `let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  while (true) {
    const end = buffer.indexOf("\\r\\n\\r\\n")
    if (end < 0) return
    const match = /content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))
    if (!match) process.exit(2)
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"))
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true } } })
    else if (message.method === "textDocument/hover") send({ jsonrpc: "2.0", id: message.id, result: { contents: "native hover" } })
    else if (message.method === "shutdown") send({ jsonrpc: "2.0", id: message.id, result: null })
    else if (message.method === "exit") process.exit(0)
  }
})
function send(message) {
  const content = Buffer.from(JSON.stringify(message))
  process.stdout.write(Buffer.concat([Buffer.from(\`Content-Length: \${content.length}\\r\\n\\r\\n\`), content]))
}
`,
  )
  await writeFile(join(root, "source.ts"), "const value = 1\n")
  await writeFile(join(root, "package.json"), "{}")
  return {
    root,
    definition: {
      state: "enabled",
      server: {
        id: "fixture",
        command: process.execPath,
        args: [server],
        fileTypes: { ".ts": "typescript" },
        rootMarkers: ["package.json"],
        env: {},
        timeoutMs: 2_000,
      },
    },
  }
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("native LSP manager", () => {
  test("owns initialization, synchronization, queries, restart, and shutdown", async () => {
    const { root, definition } = await fixture()
    const manager = new LspManager([definition])
    managers.push(manager)

    expect(manager.hasAvailableServer(root)).toBe(true)
    expect(await manager.query({ operation: "hover", filePath: "source.ts", line: 1, column: 1 }, root)).toBe(
      "Hover information\nnative hover",
    )
    expect(manager.statusLines(root).some((line) => line.includes("fixture · ready"))).toBe(true)

    await manager.restart("fixture")
    expect(manager.statusLines(root).some((line) => line.includes("fixture · idle"))).toBe(true)
  })

  test("rejects a query cancelled before native execution", async () => {
    const { root, definition } = await fixture()
    const manager = new LspManager([definition])
    managers.push(manager)
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    await expect(
      manager.query({ operation: "hover", filePath: "source.ts", line: 1, column: 1 }, root, controller.signal),
    ).rejects.toThrow("stop")
  })
})
