import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseBoundedToolOutput } from "./output"
import { ToolOutputBudget } from "./output-budget"

test("reduces the largest fresh outputs first and never revises earlier decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-output-budget-"))
  try {
    const budget = new ToolOutputBudget([], 10_000)
    const inputs = ["a".repeat(7000), "b".repeat(4000), "small"]
    const first = await budget.apply(directory, inputs)
    expect(first[1]).toBe(inputs[1])
    expect(first[2]).toBe("small")
    const artifact = parseBoundedToolOutput(first[0]!)
    expect(artifact).toBeDefined()
    expect(await readFile(artifact!.path, "utf8")).toBe(inputs[0]!)
    const frozen = [...first]
    const second = await budget.apply(directory, ["c".repeat(6000)])
    expect(Buffer.byteLength(first.join("") + second.join(""))).toBeLessThanOrEqual(10_000)
    expect(first).toEqual(frozen)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
