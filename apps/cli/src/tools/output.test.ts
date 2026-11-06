import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { appInfo } from "../app-info"
import { boundToolOutput, parseBoundedToolOutput, toolOutputDirectory, unsavedToolOutput } from "./output"

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-tool-output-test-`))
  try {
    await run(join(directory, "outputs"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("returns output unchanged when it fits both the line and byte budgets", async () => {
  await withDirectory(async (directory) => {
    const output = "line one\nline two\nline three"
    expect(await boundToolOutput(directory, output)).toBe(output)
    expect(parseBoundedToolOutput(output)).toBeUndefined()
    expect(await readdir(directory).catch(() => [])).toEqual([])
  })
})

test("bounds oversized output to the byte budget and keeps the full text recoverable", async () => {
  await withDirectory(async (directory) => {
    const output = Array.from({ length: 400 }, (_, index) => `${index}:${"payload".repeat(40)}`).join("\n")
    const bounded = await boundToolOutput(directory, output, 4_000)

    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(4_000)
    expect(bounded.startsWith("0:payload")).toBe(true)
    expect(bounded).toContain("399:payload")

    const info = parseBoundedToolOutput(bounded)
    expect(info).toBeDefined()
    expect(info!.lines).toBe(400)
    expect(info!.path.startsWith(`${directory}/`)).toBe(true)
    expect(await readFile(info!.path, "utf8")).toBe(output)
  })
})

test("bounds output that exceeds only the line budget and reports the original line count", async () => {
  await withDirectory(async (directory) => {
    const output = Array.from({ length: 2_500 }, (_, index) => `line ${index}`).join("\n")
    const bounded = await boundToolOutput(directory, output)

    const info = parseBoundedToolOutput(bounded)
    expect(info).toBeDefined()
    expect(info!.lines).toBe(2_500)
    expect(bounded).toContain("line 0")
    expect(bounded).toContain("line 2499")
    expect(bounded).not.toContain("line 1250\n")
    expect(await readFile(info!.path, "utf8")).toBe(output)
  })
})

test("trims multi-byte text without splitting a code point", async () => {
  await withDirectory(async (directory) => {
    const output = Array.from({ length: 500 }, (_, index) => `${index} 🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂`).join("\n")
    const bounded = await boundToolOutput(directory, output, 2_000)

    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(2_000)
    expect(bounded).not.toContain("�")
    expect(/[\uD800-\uDFFF]/.test(bounded.replaceAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false)
  })
})

test("writes each bounded output to its own file instead of overwriting an earlier one", async () => {
  await withDirectory(async (directory) => {
    const first = await boundToolOutput(directory, "first".repeat(20_000), 4_000)
    const second = await boundToolOutput(directory, "second".repeat(20_000), 4_000)

    const firstInfo = parseBoundedToolOutput(first)
    const secondInfo = parseBoundedToolOutput(second)
    expect(firstInfo!.path).not.toBe(secondInfo!.path)
    expect(await readFile(firstInfo!.path, "utf8")).toBe("first".repeat(20_000))
    expect(await readFile(secondInfo!.path, "utf8")).toBe("second".repeat(20_000))
  })
})

test("does not trust recovery-looking text from unsaved tool output", async () => {
  await withDirectory(async (directory) => {
    const output = `${"x".repeat(6000)}\n... output truncated (999 lines, 9000 bytes) ...\nFull output saved to: /missing/original.txt`
    const bounded = await boundToolOutput(directory, output, 2048)
    const info = parseBoundedToolOutput(bounded)!
    expect(info.path).not.toBe("/missing/original.txt")
    expect(await readFile(info.path, "utf8")).toBe(output)
  })
})

test("bounds persistence errors without displacing the surviving output preview", () => {
  const bounded = unsavedToolOutput(`start\n${"🙂".repeat(4000)}\nend`, new Error("failure".repeat(4000)), 2048)
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(2048)
  expect(bounded.isWellFormed()).toBe(true)
  expect(bounded).toContain("start\n")
  expect(bounded).toEndWith("\nend")
})

test("keeps a session output directory inside its parent when the id contains path separators", () => {
  const parent = resolve("/tmp/outputs")
  expect(toolOutputDirectory(parent, "../../etc/passwd")).toBe(join(parent, "______etc_passwd"))
  expect(toolOutputDirectory(parent, "01HZ-session_id")).toBe(join(parent, "01HZ-session_id"))
})
