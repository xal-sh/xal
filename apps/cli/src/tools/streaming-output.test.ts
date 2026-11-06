import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStreamingOutput } from "./streaming-output"

test("spools oversized output with a bounded preview and transfers the original log without replaying its preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-stream-output-"))
  try {
    const output = createStreamingOutput(directory, 4096)
    const first = `first\n${"🙂".repeat(12_000)}\n`
    output.append(first)
    const transfer = output.transfer()
    expect(Buffer.byteLength(transfer.text)).toBeLessThanOrEqual(4096)
    expect(transfer.text.isWellFormed()).toBe(true)
    transfer.log.append("last\n")
    await transfer.log.close()
    await output.close()
    expect(await readFile(transfer.log.path, "utf8")).toBe(`${first}last\n`)
    expect((await stat(transfer.log.path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports lost process output and persistence failure without claiming a complete artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xal-stream-incomplete-"))
  try {
    const output = createStreamingOutput(directory, 4096)
    output.append("start\n" + "x".repeat(10_000) + "\nend")
    const { output: result, outputSaved } = await output.finish(true)
    expect(outputSaved).toBe(true)
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096)
    expect(result).toContain("Output incomplete")
    expect(result).toContain("Partial output saved to:")
    expect(result).not.toContain("Full output saved to:")
    const path = join(directory, "not-a-directory")
    await writeFile(path, "blocked")
    const failed = createStreamingOutput(path, 4096)
    failed.append("x".repeat(10_000))
    const { output: failure, outputSaved: failedSave } = await failed.finish(false)
    expect(failedSave).toBeUndefined()
    expect(failure).toStartWith("Tool completed, but its output could not be saved:")
    expect(Buffer.byteLength(failure)).toBeLessThanOrEqual(4096)
    await failed.close()
    const backlog = createStreamingOutput(directory, 4096)
    backlog.append("x".repeat(2 * 1024 * 1024))
    backlog.append("y".repeat(2 * 1024 * 1024))
    const { output: overflow } = await backlog.finish(false)
    expect(overflow).toContain("pending writes exceeded")
    expect(Buffer.byteLength(overflow)).toBeLessThanOrEqual(4096)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
