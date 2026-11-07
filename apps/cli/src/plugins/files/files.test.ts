import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { nativeEditFile, nativeUnifiedDiff } from "../../native"
import { knownFileState, recordFileRead } from "../../tools/file-state"
import type { JsonObject } from "../../lib/json"
import type { ToolExecutionContext, ToolResult } from "../../tools/types"
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
    sessionId: `files-test-${crypto.randomUUID()}`,
    sessionKind: "primary",
    directory: cwd,
    signal: new AbortController().signal,
    update() {},
  }
}

async function readForSession(args: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const result = await readTool.execute(args, ctx)
  if (result.read && !ctx.speculative) recordFileRead(ctx.sessionId, result.read)
  return result
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
    const ctx = context(workspace)
    await readForSession({ file_path: "existing.txt" }, ctx)

    expect((await writeTool.execute({ file_path: "existing.txt", content: "before\n" }, ctx)).output).toBe(
      "Unchanged existing.txt",
    )
    const result = await writeTool.execute({ file_path: "existing.txt", content: "after\n" }, ctx)
    expect(result.output).toBe("Updated existing.txt (+1 -1)\n@@ -1,1 +1,1 @@\n-before\n+after")
    expect((await writeTool.execute({ file_path: "existing.txt", content: "third\n" }, ctx)).output).toContain(
      "Updated existing.txt",
    )
    expect((await stat(path)).mode & 0o777).toBe(0o744)
  })
})

test.skipIf(process.platform === "win32")("write and edit preserve symlink targets and file modes", async () => {
  await withWorkspace(async (workspace) => {
    const target = join(workspace, "target.txt")
    const alias = join(workspace, "alias.txt")
    await writeFile(target, "original\n")
    await chmod(target, 0o751)
    await symlink("target.txt", alias)
    const ctx = context(workspace)
    await readForSession({ file_path: "alias.txt" }, ctx)
    await writeTool.execute({ file_path: "alias.txt", content: "written\n" }, ctx)
    await editTool.execute({ file_path: "alias.txt", old_string: "written", new_string: "edited" }, ctx)
    expect(await readFile(target, "utf8")).toBe("edited\n")
    expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o751)
    const known = await knownFileState(ctx.sessionId, alias)
    expect(known).toBeDefined()
    expect(known).toBe(await knownFileState(ctx.sessionId, target))
    expect((await readdir(workspace)).sort()).toEqual(["alias.txt", "target.txt"])
  })
})

test.skipIf(process.platform === "win32")("write refuses dangling symlinks without replacing them", async () => {
  await withWorkspace(async (workspace) => {
    const alias = join(workspace, "alias.txt")
    await symlink("missing.txt", alias)
    await expect(
      writeTool.execute({ file_path: "alias.txt", content: "replacement" }, context(workspace)),
    ).rejects.toThrow("dangling symlinks are not replaced")
    expect((await lstat(alias)).isSymbolicLink()).toBe(true)
    expect(await readdir(workspace)).toEqual(["alias.txt"])
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
      "old_string matches 2 locations in repeated.txt, starting at lines 1, 3. Add surrounding lines to make it unique, or set replace_all to true.",
    )
    expect(await readFile(path, "utf8")).toBe("same\nmiddle\nsame\n")
  })
})

test("edit replaces every requested occurrence and reports accurate line counts", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "repeated.txt")
    await writeFile(path, "red\nkeep\nred\n")
    const ctx = context(workspace)
    await readForSession({ file_path: "repeated.txt" }, ctx)

    const result = await editTool.execute(
      { file_path: "repeated.txt", old_string: "red", new_string: "blue", replace_all: true },
      ctx,
    )

    expect(await readFile(path, "utf8")).toBe("blue\nkeep\nblue\n")
    expect(result.output).toContain("Updated repeated.txt (+2 -2)")
    expect(result.output).toContain("-red\n+blue\n keep\n-red\n+blue")
  })
})

test("edit applies several replacements against the original file or none at all", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "multi.txt")
    await writeFile(path, "alpha\nbeta\ngamma\n")
    const ctx = context(workspace)

    await expect(
      editTool.execute(
        {
          file_path: "multi.txt",
          edits: [
            { old_string: "alpha", new_string: "one" },
            { old_string: "missing", new_string: "two" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("edits[1]: old_string not found in multi.txt.")
    await expect(
      editTool.execute(
        {
          file_path: "multi.txt",
          edits: [
            { old_string: "alpha\nbeta", new_string: "one" },
            { old_string: "beta\ngamma", new_string: "two" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("edits[0] and edits[1] replace overlapping text in multi.txt. Merge them into one edit.")
    await expect(
      editTool.execute(
        {
          file_path: "multi.txt",
          old_string: "alpha",
          new_string: "one",
          edits: [{ old_string: "beta", new_string: "two" }],
        },
        ctx,
      ),
    ).rejects.toThrow("Pass either old_string, new_string, and replace_all, or edits, not both")
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n")

    const result = await editTool.execute(
      {
        file_path: "multi.txt",
        edits: [
          { old_string: "gamma", new_string: "three" },
          { old_string: "alpha", new_string: "beta" },
          { old_string: "beta\n", new_string: "two\n" },
        ],
      },
      ctx,
    )
    expect(await readFile(path, "utf8")).toBe("beta\ntwo\nthree\n")
    expect(result.output).toStartWith("Updated multi.txt (+2 -2)")
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

test("edit matches text copied from read output and CRLF files", async () => {
  await withWorkspace(async (workspace) => {
    const numbered = join(workspace, "numbered.txt")
    await writeFile(numbered, "alpha\nbeta\n")
    const numberedResult = await editTool.execute(
      {
        file_path: "numbered.txt",
        old_string: "     1: alpha\n     2: beta\n",
        new_string: "     1: gamma\n     2: beta\n",
      },
      context(workspace),
    )
    expect(await readFile(numbered, "utf8")).toBe("gamma\nbeta\n")
    expect(numberedResult.output).toContain("Updated numbered.txt (+1 -1)")
    await editTool.execute(
      {
        file_path: "numbered.txt",
        old_string: "     1: gamma\n     2: beta\n",
        new_string: "delta\nbeta\n",
      },
      context(workspace),
    )
    expect(await readFile(numbered, "utf8")).toBe("delta\nbeta\n")

    const crlf = join(workspace, "crlf.txt")
    await writeFile(crlf, "red\r\nkeep\r\nred\r\n")
    const crlfContext = context(workspace)
    await readForSession({ file_path: "crlf.txt" }, crlfContext)
    const crlfResult = await editTool.execute(
      { file_path: "crlf.txt", old_string: "red\n", new_string: "blue\n", replace_all: true },
      crlfContext,
    )
    expect(await readFile(crlf, "utf8")).toBe("blue\r\nkeep\r\nblue\r\n")
    expect(crlfResult.output).toContain("Updated crlf.txt (+2 -2)")

    const literal = join(workspace, "literal.txt")
    await writeFile(literal, "     1: kept\n")
    await editTool.execute(
      { file_path: "literal.txt", old_string: "     1: kept\n", new_string: "     1: next\n" },
      context(workspace),
    )
    expect(await readFile(literal, "utf8")).toBe("     1: next\n")
  })
})

test("edit rejects empty matches and invalid UTF-8 without modifying the file", async () => {
  await withWorkspace(async (workspace) => {
    await expect(
      nativeEditFile({
        path: join(workspace, "missing.txt"),
        displayPath: "missing.txt",
        edits: [{ oldString: "", newString: "new", replaceAll: false }],
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
    await mkdir(join(workspace, "directory", "nested"), { recursive: true })
    await writeFile(join(workspace, "directory", "entry.ts"), "")

    expect((await readForSession({ file_path: "empty.txt" }, context(workspace))).output).toBe("(empty file)")
    await expect(readTool.execute({ file_path: "missing.txt" }, context(workspace))).rejects.toThrow(
      "File not found: missing.txt",
    )
    await expect(readTool.execute({ file_path: "directory/entry.js" }, context(workspace))).rejects.toThrow(
      "File not found: directory/entry.js. Similarly named files in the same directory: directory/entry.ts",
    )
    const listing = context(workspace)
    expect((await readForSession({ file_path: "directory" }, listing)).output).toBe(
      "directory is a directory. Its entries:\nentry.ts\nnested/\n(End of directory - 2 entries)",
    )
    expect(await knownFileState(listing.sessionId, join(workspace, "directory"))).toBeUndefined()
    await expect(readTool.execute({ file_path: "binary.dat" }, context(workspace))).rejects.toThrow(
      "Cannot read binary file: binary.dat",
    )
  })
})

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "latin1")
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

test("read returns PNG and JPEG files as images and refuses ones a provider would reject", async () => {
  await withWorkspace(async (workspace) => {
    const screenshot = png(1440, 900)
    await writeFile(join(workspace, "shot.png"), screenshot)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x00])
    await writeFile(join(workspace, "photo.JPG"), jpeg)
    await writeFile(join(workspace, "tall.png"), png(1000, 9000))
    await writeFile(join(workspace, "fake.png"), "not\u0000an image")
    await writeFile(join(workspace, "large.jpg"), `${"x".repeat(4_000_000)}\u0000`)

    const shot = await readForSession({ file_path: "shot.png" }, context(workspace))
    expect(shot.output).toBe("Image shot.png: image/png, 1440×900 pixels, 1 KB")
    expect(shot.images).toEqual([{ mediaType: "image/png", data: screenshot.toString("base64") }])
    const photo = await readForSession({ file_path: "photo.JPG" }, context(workspace))
    expect(photo.output).toBe("Image photo.JPG: image/jpeg, 64×32 pixels, 1 KB")
    await expect(readTool.execute({ file_path: "tall.png" }, context(workspace))).rejects.toThrow(
      "tall.png is 1000×9000 pixels; images wider or taller than 8000 pixels cannot be attached",
    )
    await expect(readTool.execute({ file_path: "fake.png" }, context(workspace))).rejects.toThrow(
      "Cannot read binary file: fake.png",
    )
    await expect(readTool.execute({ file_path: "large.jpg" }, context(workspace))).rejects.toThrow(
      "Cannot read binary file: large.jpg",
    )
    await expect(readTool.execute({ file_path: "gone.png" }, context(workspace))).rejects.toThrow(
      "File not found: gone.png",
    )
  })
})

test("read preserves Unicode, line truncation, and continuation wording", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "unicode.txt"), `first\n猫 🔐\n${"x".repeat(2001)}\nlast\n`)
    const first = await readForSession({ file_path: "unicode.txt", offset: 2, limit: 2 }, context(workspace))
    expect(first.output).toBe(
      `     2: 猫 🔐\n     3: ${"x".repeat(2000)}… (line truncated)\n(Showing lines 2-3 of 4. Use offset=4 to continue.)`,
    )
    expect((await readForSession({ file_path: "unicode.txt", offset: 4 }, context(workspace))).output).toBe(
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

test("write refuses an existing file that was never read in this session", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "unread.txt"), "original\n")

    await expect(
      writeTool.execute({ file_path: "unread.txt", content: "replaced\n" }, context(workspace)),
    ).rejects.toThrow("has not been read completely in this session")
    expect(await readFile(join(workspace, "unread.txt"), "utf8")).toBe("original\n")
  })
})

test("write refuses a file that changed after it was read", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "raced.txt")
    await writeFile(path, "original\n")
    const ctx = context(workspace)
    await readForSession({ file_path: "raced.txt" }, ctx)
    await writeFile(path, "changed by someone else\n")

    await expect(writeTool.execute({ file_path: "raced.txt", content: "replaced\n" }, ctx)).rejects.toThrow(
      "changed since it was read",
    )
    expect(await readFile(path, "utf8")).toBe("changed by someone else\n")
  })
})

test("write recreates a file that was deleted after it was read", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "recreated.txt")
    await writeFile(path, "original\n")
    const ctx = context(workspace)
    await readForSession({ file_path: "recreated.txt" }, ctx)
    await rm(path)

    expect((await writeTool.execute({ file_path: "recreated.txt", content: "again\n" }, ctx)).output).toContain(
      "Created recreated.txt",
    )
    expect((await writeTool.execute({ file_path: "recreated.txt", content: "later\n" }, ctx)).output).toContain(
      "Updated recreated.txt",
    )
  })
})

test("an unread targeted edit does not authorize whole-file writes or replace_all", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "unread.txt")
    await writeFile(path, "target\nunseen\n")
    const ctx = context(workspace)

    await editTool.execute({ file_path: "unread.txt", old_string: "target", new_string: "edited" }, ctx)
    await expect(writeTool.execute({ file_path: "unread.txt", content: "edited\n" }, ctx)).rejects.toThrow(
      "has not been read completely in this session",
    )
    await expect(
      editTool.execute({ file_path: "unread.txt", old_string: "unseen", new_string: "lost", replace_all: true }, ctx),
    ).rejects.toThrow("has not been read completely in this session")
    expect(await readFile(path, "utf8")).toBe("edited\nunseen\n")
  })
})

test("a targeted edit cannot refresh authorization after an unseen external change", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "shared.txt")
    await writeFile(path, "target\noriginal\n")
    const ctx = context(workspace)
    await readForSession({ file_path: "shared.txt" }, ctx)
    await writeFile(path, "target\nexternal change\n")

    await editTool.execute({ file_path: "shared.txt", old_string: "target", new_string: "edited" }, ctx)
    await editTool.execute({ file_path: "shared.txt", old_string: "edited", new_string: "done" }, ctx)
    await expect(writeTool.execute({ file_path: "shared.txt", content: "done\noriginal\n" }, ctx)).rejects.toThrow()
    await expect(
      editTool.execute({ file_path: "shared.txt", old_string: "done", new_string: "lost", replace_all: true }, ctx),
    ).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("done\nexternal change\n")

    await readForSession({ file_path: "shared.txt" }, ctx)
    await editTool.execute(
      { file_path: "shared.txt", old_string: "done", new_string: "reread", replace_all: true },
      ctx,
    )
    await writeTool.execute({ file_path: "shared.txt", content: "reread\nexternal change\nkept\n" }, ctx)
    expect(await readFile(path, "utf8")).toBe("reread\nexternal change\nkept\n")
  })
})

test("targeted edits preserve authorization when their original file version was known", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "known.txt")
    await writeFile(path, "alpha\nbeta\nkeep\n")
    const ctx = context(workspace)
    await readForSession({ file_path: "known.txt" }, ctx)

    await editTool.execute(
      {
        file_path: "known.txt",
        edits: [
          { old_string: "alpha", new_string: "one" },
          { old_string: "beta", new_string: "two" },
        ],
      },
      ctx,
    )
    await editTool.execute({ file_path: "known.txt", old_string: "one", new_string: "three" }, ctx)
    await editTool.execute({ file_path: "known.txt", old_string: "two", new_string: "four", replace_all: true }, ctx)
    await writeTool.execute({ file_path: "known.txt", content: "three\nfour\nkeep\nlast\n" }, ctx)
    expect(await readFile(path, "utf8")).toBe("three\nfour\nkeep\nlast\n")
  })
})

test("broad mutations require every line, merging overlapping pages through canonical aliases", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "paged.txt")
    await writeFile(path, "one\ntwo\nthree\nfour\n")
    await symlink(path, join(workspace, "alias.txt"))
    const ctx = context(workspace)
    await readForSession({ file_path: "alias.txt", offset: 4 }, ctx)
    await readForSession({ file_path: "paged.txt", limit: 1 }, ctx)
    await expect(writeTool.execute({ file_path: "paged.txt", content: "lost\n" }, ctx)).rejects.toThrow(
      "has not been read completely",
    )
    await expect(
      editTool.execute({ file_path: "alias.txt", old_string: "o", new_string: "O", replace_all: true }, ctx),
    ).rejects.toThrow("has not been read completely")
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\nfour\n")
    await readForSession({ file_path: "paged.txt", offset: 2, limit: 2 }, ctx)
    await readForSession({ file_path: "alias.txt", limit: 2 }, ctx)
    await writeTool.execute({ file_path: "alias.txt", content: "all seen\n" }, ctx)
    expect(await readFile(path, "utf8")).toBe("all seen\n")
  })
})

test("partial reads of changed versions and targeted edits cannot promote incomplete knowledge", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "changing.txt")
    const ctx = context(workspace)
    await writeFile(path, "first\nold\n")
    await readForSession({ file_path: path }, ctx)
    await writeFile(path, "unseen change\nlast\n")
    await readForSession({ file_path: path, offset: 2 }, ctx)
    await expect(writeTool.execute({ file_path: path, content: "lost\n" }, ctx)).rejects.toThrow(
      "has not been read completely",
    )
    await editTool.execute({ file_path: path, old_string: "last", new_string: "edited\nextra" }, ctx)
    await readForSession({ file_path: path, limit: 1 }, ctx)
    await expect(
      editTool.execute({ file_path: path, old_string: "edited", new_string: "lost", replace_all: true }, ctx),
    ).rejects.toThrow("has not been read completely")
    expect(await readFile(path, "utf8")).toBe("unseen change\nedited\nextra\n")
    await readForSession({ file_path: path, offset: 2 }, ctx)
    await writeTool.execute({ file_path: path, content: "complete\n" }, ctx)
  })
})

test("shortened lines and native output caps do not authorize writes, while empty reads do", async () => {
  await withWorkspace(async (workspace) => {
    for (const content of ["x".repeat(2001), Array.from({ length: 100 }, () => "y".repeat(1000)).join("\n")]) {
      const path = join(workspace, "bounded.txt")
      const ctx = context(workspace)
      await writeFile(path, content)
      await readForSession({ file_path: path }, ctx)
      await expect(writeTool.execute({ file_path: path, content: "lost" }, ctx)).rejects.toThrow(
        "has not been read completely",
      )
      expect(await readFile(path, "utf8")).toBe(content)
    }
    const ctx = context(workspace)
    await writeFile(join(workspace, "empty.txt"), "")
    await readForSession({ file_path: "empty.txt" }, ctx)
    await writeTool.execute({ file_path: "empty.txt", content: "filled\n" }, ctx)
    expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("filled\n")
  })
})

test("edit needs no prior read but replace_all requires an unchanged read", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "targets.txt")
    await writeFile(path, "value\nother\n")
    await expect(
      editTool.execute(
        { file_path: "targets.txt", old_string: "value", new_string: "kept", replace_all: true },
        context(workspace),
      ),
    ).rejects.toThrow("has not been read completely in this session")
    expect(await readFile(path, "utf8")).toBe("value\nother\n")
    const ctx = context(workspace)

    expect(
      (await editTool.execute({ file_path: "targets.txt", old_string: "value", new_string: "kept" }, ctx)).output,
    ).toContain("Updated targets.txt")

    await readForSession({ file_path: "targets.txt" }, ctx)
    await writeFile(path, "kept\nother\nkept\n")
    await expect(
      editTool.execute({ file_path: "targets.txt", old_string: "kept", new_string: "done", replace_all: true }, ctx),
    ).rejects.toThrow("changed since it was read")
  })
})
