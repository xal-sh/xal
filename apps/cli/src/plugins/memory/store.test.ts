import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createNativeMemoryStore } from "../../native"

const directories: string[] = []

async function memoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xal-memory-test-"))
  directories.push(directory)
  return join(directory, "memory.md")
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("native memory store", () => {
  test("round trips revisions and rejects stale replacements", async () => {
    const store = createNativeMemoryStore(await memoryPath())
    const empty = await store.load([])
    const written = await store.replace("durable", empty.revision, [])
    expect(written.content).toBe("durable")
    expect(store.promptContent).toBe("durable")
    await expect(store.replace("stale", empty.revision, [])).rejects.toThrow(
      "global memory changed since it was read; read it again before replacing it",
    )
  })

  test("enforces secret and file security checks", async () => {
    const path = await memoryPath()
    const store = createNativeMemoryStore(path)
    const empty = await store.load([])
    await expect(store.replace("contains TOKEN", empty.revision, ["TOKEN"])).rejects.toThrow(
      "global memory contains a configured secret",
    )
    await writeFile(path, "public")
    await chmod(path, 0o644)
    await expect(store.load([])).rejects.toThrow("global memory file permissions must be 0600")
  })

  test("honors cancellation before a write", async () => {
    const store = createNativeMemoryStore(await memoryPath())
    const empty = await store.load([])
    const controller = new AbortController()
    controller.abort()
    await expect(store.replace("cancelled", empty.revision, [], controller.signal)).rejects.toThrow()
  })
})
