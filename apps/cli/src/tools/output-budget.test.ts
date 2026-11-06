import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boundToolOutput, parseBoundedToolOutput } from "./output"
import { createStreamingOutput } from "./streaming-output"
import { ToolOutputBudget } from "./output-budget"

test("keeps the original artifact when an existing preview must shrink again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-output-rebound-"))
  try {
    const original = Array.from({ length: 3000 }, (_, index) => `${index}: ${"🙂".repeat(40)}`).join("\n")
    const preview = await boundToolOutput(directory, original)
    const before = parseBoundedToolOutput(preview)!
    const [bounded] = await new ToolOutputBudget([], 2048).apply(directory, [{ output: preview, outputSaved: true }])
    expect(Buffer.byteLength(bounded!)).toBeLessThanOrEqual(2048)
    expect(parseBoundedToolOutput(bounded!)).toEqual(before)
    expect(await readFile(before.path, "utf8")).toBe(original)
    expect(await readdir(directory)).toHaveLength(1)

    for (const dropped of [false, true]) {
      const output = createStreamingOutput(directory, 4096)
      output.append(original)
      const captured = await output.finish(dropped)
      const streamed = `${captured.output}\n(exit code 1)`
      const [smaller] = await new ToolOutputBudget([], 2048).apply(directory, [{ ...captured, output: streamed }])
      expect(Buffer.byteLength(smaller!)).toBeLessThanOrEqual(2048)
      expect(smaller).toEndWith(
        streamed.slice(streamed.indexOf(dropped ? "[Output incomplete:" : "Full output saved to:")),
      )
      if (dropped) expect(smaller).not.toContain("Full output saved to:")
    }
    expect(await readdir(directory)).toHaveLength(3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("retains a bounded head and tail when aggregate output cannot be saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-output-unsaved-"))
  try {
    const blocked = join(directory, "blocked")
    await writeFile(blocked, "not a directory")
    const [bounded] = await new ToolOutputBudget([], 2048).apply(blocked, [
      { output: `start\n${"🙂".repeat(4000)}\nend` },
    ])
    expect(bounded).toStartWith("Tool completed, but its output could not be saved:")
    expect(bounded).toContain("start\n")
    expect(bounded).toEndWith("\nend")
    expect(bounded).toContain("inspect it before retrying")
    expect(bounded).not.toContain("Full output saved to:")
    expect(bounded!.isWellFormed()).toBe(true)
    expect(Buffer.byteLength(bounded!)).toBeLessThanOrEqual(2048)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reduces the largest fresh outputs first and never revises earlier decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-output-budget-"))
  try {
    const budget = new ToolOutputBudget([], 10_000)
    const inputs = ["a".repeat(7000), "b".repeat(4000), "small"]
    const first = await budget.apply(
      directory,
      inputs.map((output) => ({ output })),
    )
    expect(first[1]).toBe(inputs[1])
    expect(first[2]).toBe("small")
    const artifact = parseBoundedToolOutput(first[0]!)
    expect(artifact).toBeDefined()
    expect(await readFile(artifact!.path, "utf8")).toBe(inputs[0]!)
    const frozen = [...first]
    const second = await budget.apply(directory, [{ output: "c".repeat(6000) }])
    expect(Buffer.byteLength(first.join("") + second.join(""))).toBeLessThanOrEqual(10_000)
    expect(first).toEqual(frozen)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
