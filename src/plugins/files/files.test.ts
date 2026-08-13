import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolExecutionContext } from "../../tools/types"
import { unifiedDiff } from "./diff"
import { editTool } from "./edit"
import { writeTool } from "./write"

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "tack-files-tools-"))
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function context(cwd: string): ToolExecutionContext {
  return {
    cwd,
    sessionId: "files-test",
    sessionKind: "primary",
    directory: cwd,
    signal: new AbortController().signal,
    update() {},
  }
}

test("write creates missing parent directories and reports the exact new-file diff", async () => {
  await withWorkspace(async (workspace) => {
    const result = await writeTool.execute(
      { file_path: "nested/example.txt", content: "alpha\nbeta\n" },
      context(workspace),
    )

    expect(await readFile(join(workspace, "nested", "example.txt"), "utf8")).toBe("alpha\nbeta\n")
    expect(result.output).toBe("Created nested/example.txt (2 lines)\n@@ -0,0 +1,2 @@\n+alpha\n+beta")
  })
})

test("edit rejects an ambiguous match without modifying the file", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "repeated.txt")
    await writeFile(path, "same\nmiddle\nsame\n")

    await expect(
      editTool.execute({ file_path: "repeated.txt", old_string: "same", new_string: "changed" }, context(workspace)),
    ).rejects.toThrow(
      "old_string matches 2 locations in repeated.txt. Add surrounding lines to make it unique, or set replace_all to true.",
    )
    expect(await readFile(path, "utf8")).toBe("same\nmiddle\nsame\n")
  })
})

test("edit replaces every requested occurrence and reports accurate line counts", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "repeated.txt")
    await writeFile(path, "red\nkeep\nred\n")

    const result = await editTool.execute(
      { file_path: "repeated.txt", old_string: "red", new_string: "blue", replace_all: true },
      context(workspace),
    )

    expect(await readFile(path, "utf8")).toBe("blue\nkeep\nblue\n")
    expect(result.output).toContain("Updated repeated.txt (+2 -2)")
    expect(result.output).toContain("-red\n+blue\n keep\n-red\n+blue")
  })
})

test("unified diff separates distant changes while retaining bounded context", () => {
  const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
  const after = before.replace("line 2", "changed 2").replace("line 11", "changed 11")

  expect(unifiedDiff(before, after)).toEqual({
    added: 2,
    removed: 2,
    hunks:
      "@@ -1,5 +1,5 @@\n line 1\n-line 2\n+changed 2\n line 3\n line 4\n line 5\n@@ -8,5 +8,5 @@\n line 8\n line 9\n line 10\n-line 11\n+changed 11\n line 12",
  })
})
