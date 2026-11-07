import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolResultItem } from "../../providers/types"
import { readTool } from "../../plugins/files/read"
import { parseRecord } from "../../sessions/records"
import type { ReadCoverage } from "../../tools/read-coverage"
import type { ToolExecutionContext } from "../../tools/types"
import { pruneStaleReads } from "./stale-reads"

function result(callId: string, read?: Partial<ReadCoverage>): ToolResultItem {
  return {
    type: "tool_result",
    callId,
    output: `${callId} ${"x".repeat(400)}`,
    ...(read
      ? { read: { path: "/workspace/a.ts", contentHash: "version", offset: 1, limit: 50, truncated: false, ...read } }
      : {}),
  }
}

test("prunes only visible covering reads of the same canonical file version", () => {
  const items = [
    result("covered", { offset: 10, limit: 5 }),
    result("tail", { offset: 100, limit: 10 }),
    result("other-version", { contentHash: "old" }),
    result("other-workspace", { path: "/worktree/a.ts" }),
    result("unknown"),
    result("later", {}),
  ]
  const pruned = pruneStaleReads(items)
  expect(pruned.pruned).toBe(1)
  expect(pruned.items[0]).toMatchObject({
    output: expect.stringContaining("Removed during compaction"),
    read: undefined,
  })
  expect(pruned.items.slice(1)).toEqual(items.slice(1))
  expect(pruneStaleReads(pruned.items).pruned).toBe(0)
  expect(pruneStaleReads([result("old", {}), result("truncated", { truncated: true })]).pruned).toBe(0)
})

test("legacy coverage round-trips while invalid total-line metadata is rejected", () => {
  const item = result("legacy", {})
  expect(parseRecord(JSON.stringify({ type: "item", item }))).toEqual({ type: "item", item })
  for (const totalLines of [-1, "50", 49, null]) {
    expect(() =>
      parseRecord(JSON.stringify({ type: "item", item: { ...item, read: { ...item.read, totalLines } } })),
    ).toThrow("malformed session record")
  }
})

test("a default native read cannot supersede the file tail, including after persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-read-coverage-"))
  const path = join(directory, "large.txt")
  const context: ToolExecutionContext = {
    cwd: directory,
    directory,
    sessionId: crypto.randomUUID(),
    sessionKind: "primary",
    signal: new AbortController().signal,
    update() {},
  }
  try {
    await writeFile(
      path,
      Array.from({ length: 3100 }, (_, index) => (index === 2999 ? "ONLY_TAIL_EVIDENCE" : `row ${index + 1}`)).join(
        "\n",
      ),
    )
    const tail = await readTool.execute({ file_path: path, offset: 3000, limit: 50 }, context)
    const head = await readTool.execute({ file_path: "large.txt" }, context)
    expect(tail.read).toMatchObject({ offset: 3000, limit: 50, truncated: false, totalLines: 3100 })
    expect(head.read).toMatchObject({ offset: 1, limit: 2000, contentHash: tail.read?.contentHash })
    const items: ToolResultItem[] = [
      { type: "tool_result", callId: "tail", ...tail },
      { type: "tool_result", callId: "head", ...head },
    ]
    for (const item of items)
      expect(parseRecord(JSON.stringify({ type: "item", item }))).toEqual({ type: "item", item })
    const pruned = pruneStaleReads(items)
    expect(pruned.pruned).toBe(0)
    expect(JSON.stringify(pruned.items)).toContain("ONLY_TAIL_EVIDENCE")
    await writeFile(path, `${"x".repeat(2100)}\n${Array.from({ length: 500 }, () => "y".repeat(500)).join("\n")}`)
    const capped = await readTool.execute({ file_path: path }, context)
    expect(capped.read?.truncated).toBe(true)
    expect(capped.read?.limit).toBeLessThan(501)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
