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

test("grep handles explicit targets, invalid expressions, binary files, long lines, and interruption", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "nested"))
    await writeFile(join(workspace, "nested", "target.txt"), `${"x".repeat(501)}needle\n`)
    await writeFile(join(workspace, "nested", "binary.txt"), "needle\u0000binary")

    const target = await grepTool.execute({ pattern: "needle", path: "nested" }, context(workspace))
    expect(target.output).toBe("Found 1 matching lines\nnested/target.txt:1:[Omitted long matching line]")
    await expect(grepTool.execute({ pattern: "[" }, context(workspace))).rejects.toThrow("ripgrep error:")

    const abort = new AbortController()
    abort.abort()
    expect((await grepTool.execute({ pattern: "needle" }, context(workspace, abort.signal))).output).toBe(
      "(interrupted by user)",
    )
  })
})

test("grep counts every match while retaining only the first 250 lines", async () => {
  await withWorkspace(async (workspace) => {
    const content = Array.from({ length: 260 }, (_, index) => `needle ${index}`).join("\n")
    await writeFile(join(workspace, "many.txt"), content)
    const result = await grepTool.execute({ pattern: "needle" }, context(workspace))
    expect(result.output.startsWith("Found 260 matching lines\n")).toBe(true)
    expect(result.output.endsWith("(Showing first 250 of 260. Narrow your pattern or path.)")).toBe(true)
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
    expect(lines[101]).toBe("(Showing first 100 of 105. Narrow the pattern to see the rest.)")
  })
})
