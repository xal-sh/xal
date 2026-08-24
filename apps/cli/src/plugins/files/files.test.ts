import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { nativeEditFile, nativeUnifiedDiff } from "../../native"
import type { ToolExecutionContext } from "../../tools/types"
import { editTool } from "./edit"
import { readTool } from "./read"
import { writeTool } from "./write"

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `${appInfo.name}-files-tools-`))
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

test("write reports unchanged and update outcomes while preserving permissions", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "existing.txt")
    await writeFile(path, "before\n")
    await chmod(path, 0o744)

    expect(
      (await writeTool.execute({ file_path: "existing.txt", content: "before\n" }, context(workspace))).output,
    ).toBe("Unchanged existing.txt")
    const result = await writeTool.execute({ file_path: "existing.txt", content: "after\n" }, context(workspace))
    expect(result.output).toBe("Updated existing.txt (+1 -1)\n@@ -1,1 +1,1 @@\n-before\n+after")
    expect((await stat(path)).mode & 0o777).toBe(0o744)
  })
})

test("write rejects directory targets", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, "directory"))
    await expect(writeTool.execute({ file_path: "directory", content: "value" }, context(workspace))).rejects.toThrow(
      "Path is a directory, not a file: directory",
    )
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

test("edit reports missing paths and exact no-match failures without mutation", async () => {
  await withWorkspace(async (workspace) => {
    await expect(
      editTool.execute({ file_path: "missing.txt", old_string: "old", new_string: "new" }, context(workspace)),
    ).rejects.toThrow("File not found: missing.txt")
    const path = join(workspace, "present.txt")
    await writeFile(path, "present\n")
    await expect(
      editTool.execute({ file_path: "present.txt", old_string: "missing", new_string: "new" }, context(workspace)),
    ).rejects.toThrow(
      "old_string not found in present.txt. It must match the file text exactly, including whitespace and indentation.",
    )
    expect(await readFile(path, "utf8")).toBe("present\n")
  })
})

test("edit rejects empty matches and invalid UTF-8 without modifying the file", async () => {
  await withWorkspace(async (workspace) => {
    await expect(
      nativeEditFile({
        path: join(workspace, "missing.txt"),
        expectedPath: join(workspace, "missing.txt"),
        displayPath: "missing.txt",
        oldString: "",
        newString: "new",
        replaceAll: false,
      }),
    ).rejects.toThrow("old_string is required and must be non-empty")
    const path = join(workspace, "invalid-utf8.txt")
    const bytes = [0xff, 0xfe, 0xfd]
    await writeFile(path, Uint8Array.from(bytes))

    await expect(
      editTool.execute({ file_path: "invalid-utf8.txt", old_string: "old", new_string: "new" }, context(workspace)),
    ).rejects.toThrow("invalid utf-8")
    expect(Array.from(await readFile(path))).toEqual(bytes)
  })
})

test("read handles empty, missing, directory, and binary files", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "empty.txt"), "")
    await writeFile(join(workspace, "binary.dat"), "text\u0000tail")
    await mkdir(join(workspace, "directory"))

    expect((await readTool.execute({ file_path: "empty.txt" }, context(workspace))).output).toBe("(empty file)")
    await expect(readTool.execute({ file_path: "missing.txt" }, context(workspace))).rejects.toThrow(
      "File not found: missing.txt",
    )
    await expect(readTool.execute({ file_path: "directory" }, context(workspace))).rejects.toThrow(
      "Path is a directory, not a file: directory",
    )
    await expect(readTool.execute({ file_path: "binary.dat" }, context(workspace))).rejects.toThrow(
      "Cannot read binary file: binary.dat",
    )
  })
})

test("read preserves Unicode, line truncation, and continuation wording", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "unicode.txt"), `first\n猫 🔐\n${"x".repeat(2001)}\nlast\n`)
    const first = await readTool.execute({ file_path: "unicode.txt", offset: 2, limit: 2 }, context(workspace))
    expect(first.output).toBe(
      `     2: 猫 🔐\n     3: ${"x".repeat(2000)}… (line truncated)\n(Showing lines 2-3 of 4. Use offset=4 to continue.)`,
    )
    expect((await readTool.execute({ file_path: "unicode.txt", offset: 4 }, context(workspace))).output).toBe(
      "     4: last\n(End of file - 4 lines)",
    )
    await expect(readTool.execute({ file_path: "unicode.txt", offset: 5 }, context(workspace))).rejects.toThrow(
      "Offset 5 is past the end of the file (4 lines)",
    )
  })
})

test("unified diff separates distant changes while retaining bounded context", () => {
  const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
  const after = before.replace("line 2", "changed 2").replace("line 11", "changed 11")

  expect(nativeUnifiedDiff(before, after)).toEqual({
    added: 2,
    removed: 2,
    hunks:
      "@@ -1,5 +1,5 @@\n line 1\n-line 2\n+changed 2\n line 3\n line 4\n line 5\n@@ -8,5 +8,5 @@\n line 8\n line 9\n line 10\n-line 11\n+changed 11\n line 12",
  })
  expect(nativeUnifiedDiff("", "\ud800").hunks).toBe("@@ -0,0 +1,1 @@\n+\ud800")
})
