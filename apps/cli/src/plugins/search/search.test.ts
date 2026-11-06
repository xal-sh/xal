import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import type { ToolExecutionContext } from "../../tools/types"
import { globTool } from "./glob"
import { grepTool } from "./grep"

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `${appInfo.name}-search-tools-`))
  try {
    await mkdir(join(workspace, ".git"))
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function context(cwd: string, signal = new AbortController().signal): ToolExecutionContext {
  return {
    cwd,
    sessionId: "search-test",
    sessionKind: "primary",
    directory: cwd,
    signal,
    update() {},
  }
}

test("grep honors ignores, includes hidden files, and preserves content and files output", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "src"))
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n")
    await writeFile(join(workspace, "ignored.txt"), "needle ignored\n")
    await writeFile(join(workspace, ".hidden"), "needle hidden\n")
    await writeFile(join(workspace, "src", "match.ts"), "first\nneedle visible\n")
    await writeFile(join(workspace, "src", "other.js"), "needle javascript\n")

    const content = await grepTool.execute(
      { pattern: "NEEDLE", case_insensitive: true, glob: "*.ts" },
      context(workspace),
    )
    expect(content.output).toBe("Found 1 matching lines\nsrc/match.ts:2:needle visible")

    const files = await grepTool.execute({ pattern: "needle", output_mode: "files" }, context(workspace))
    expect(files.output).toBe("Found 3 files\n.hidden\nsrc/match.ts\nsrc/other.js")
    const targeted = await globTool.execute({ pattern: "src/**", path: "src" }, context(workspace))
    expect(targeted.output.split("\n")[0]).toBe("Found 2 files")
  })
})

test("grep handles explicit targets, invalid expressions, literal text, binary files, long lines, and interruption", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "nested"))
    await writeFile(join(workspace, "nested", "target.txt"), `${"x".repeat(501)}needle\n`)
    await writeFile(join(workspace, "nested", "binary.txt"), "needle\u0000binary")

    const target = await grepTool.execute({ pattern: "needle", path: "nested" }, context(workspace))
    expect(target.output).toBe("Found 1 matching lines\nnested/target.txt:1:[Omitted long matching line]")
    await expect(grepTool.execute({ pattern: "[" }, context(workspace))).rejects.toThrow("ripgrep error:")
    await writeFile(join(workspace, "nested", "call.ts"), "run(a.b)\nrunaxb\n")
    const literal = await grepTool.execute({ pattern: "run(a.b)", literal: true, path: "nested" }, context(workspace))
    expect(literal.output).toBe("Found 1 matching lines\nnested/call.ts:1:run(a.b)")

    const abort = new AbortController()
    abort.abort()
    expect((await grepTool.execute({ pattern: "needle" }, context(workspace, abort.signal))).output).toBe(
      "(interrupted by user)",
    )
  })
})

test("grep and glob name a missing search path and similarly named siblings", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "src", "tests"), { recursive: true })

    await expect(grepTool.execute({ pattern: "needle", path: "src/Tests.d" }, context(workspace))).rejects.toThrow(
      "Path not found: src/Tests.d. Similarly named files in the same directory: src/tests",
    )
    await expect(globTool.execute({ pattern: "*.ts", path: "gone/src" }, context(workspace))).rejects.toThrow(
      "Path not found: gone/src. Its directory does not exist either.",
    )
  })
})

test("grep counts every match while retaining only the first 250 lines", async () => {
  await withWorkspace(async (workspace) => {
    const content = Array.from({ length: 260 }, (_, index) => `needle ${index}`).join("\n")
    await writeFile(join(workspace, "many.txt"), content)
    const result = await grepTool.execute({ pattern: "needle" }, context(workspace))
    expect(result.output.startsWith("Found 260 matching lines\n")).toBe(true)
    expect(
      result.output.endsWith("(Showing 1-250 of 260. Narrow your pattern or path, or pass offset 250 for more.)"),
    ).toBe(true)
    const rest = await grepTool.execute({ pattern: "needle", offset: 250 }, context(workspace))
    expect(rest.output.split("\n").slice(1)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `many.txt:${index + 251}:needle ${index + 250}`),
      "(Showing 251-260 of 260.)",
    ])
    await expect(grepTool.execute({ pattern: "needle", offset: -1 }, context(workspace))).rejects.toThrow(
      "offset must be a non-negative integer",
    )
  })
})

test("grep shows surrounding context and separates non-adjacent groups", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "code.ts"), "a\nneedle one\nb\nc\nd\ne\nneedle two\nf\n")
    const result = await grepTool.execute({ pattern: "needle", context: 1 }, context(workspace))
    expect(result.output).toBe(
      [
        "Found 2 matching lines",
        "code.ts-1-a",
        "code.ts:2:needle one",
        "code.ts-3-b",
        "--",
        "code.ts-6-e",
        "code.ts:7:needle two",
        "code.ts-8-f",
      ].join("\n"),
    )
    const paged = await grepTool.execute({ pattern: "needle", context: 1, offset: 1 }, context(workspace))
    expect(paged.output).toBe(
      ["Found 2 matching lines", "code.ts-6-e", "code.ts:7:needle two", "code.ts-8-f", "(Showing 2-2 of 2.)"].join(
        "\n",
      ),
    )
  })
})

test("glob returns newest matches first with a bounded payload and accurate total", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, ".gitignore"), "ignored-*.txt\n")
    for (let index = 0; index < 105; index++) {
      const path = join(workspace, `match-${String(index).padStart(3, "0")}.txt`)
      await writeFile(path, String(index))
      await utimes(path, index + 1, index + 1)
    }
    await writeFile(join(workspace, "ignored-one.txt"), "ignored")
    const result = await globTool.execute({ pattern: "*.txt" }, context(workspace))
    const lines = result.output.split("\n")
    expect(lines[0]).toBe("Found 105 files")
    expect(lines[1]).toBe("match-104.txt")
    expect(lines[100]).toBe("match-005.txt")
    expect(lines[101]).toBe("(Showing 1-100 of 105. Narrow the pattern, or pass offset 100 for more.)")
    const rest = await globTool.execute({ pattern: "*.txt", offset: 100 }, context(workspace))
    expect(rest.output.split("\n")).toEqual([
      "Found 105 files",
      "match-004.txt",
      "match-003.txt",
      "match-002.txt",
      "match-001.txt",
      "match-000.txt",
      "(Showing 101-105 of 105.)",
    ])
  })
})
