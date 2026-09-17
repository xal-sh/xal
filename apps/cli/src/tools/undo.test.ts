import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../app-info"
import { WorkspaceUndo } from "./undo"

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

async function withGitWorkspace(run: (workspace: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `${appInfo.name}-workspace-undo-`))
  const workspace = join(root, "workspace")
  try {
    await mkdir(workspace)
    await git(workspace, ["init", "--quiet"])
    await git(workspace, ["config", "core.autocrlf", "false"])
    await writeFile(join(workspace, "tracked.txt"), "before\n")
    await git(workspace, ["add", "tracked.txt"])
    await git(workspace, [
      "-c",
      `user.name=${appInfo.displayName} Tests`,
      "-c",
      `user.email=${appInfo.name}@example.invalid`,
      "commit",
      "--quiet",
      "-m",
      "initial",
    ])
    await run(workspace, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("rewinds and reapplies targeted updates and creations transactionally", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const created = join(workspace, "nested", "created.txt")
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Change both files")

    expect(
      await undo.trackPaths("write", [created, tracked], async () => {
        await writeFile(tracked, "after\n")
        await mkdir(join(workspace, "nested"))
        await writeFile(created, "created\n")
        return 42
      }),
    ).toBe(42)
    expect(await undo.previews()).toEqual([
      {
        messageId: "message-1",
        prompt: "Change both files",
        paths: ["nested/created.txt", "tracked.txt"],
        codeAvailable: true,
      },
    ])

    const rewind = await undo.rewind("message-1")
    expect({ count: rewind.count, steps: rewind.steps }).toEqual({ count: 2, steps: 1 })
    expect(await readFile(tracked, "utf8")).toBe("before\n")
    expect(await Bun.file(created).exists()).toBe(false)

    const redos = rewind.commit()
    expect(redos).toHaveLength(1)
    expect(redos[0]?.count).toBe(2)
    const applied = await redos[0]!.apply()
    expect(await readFile(tracked, "utf8")).toBe("after\n")
    expect(await readFile(created, "utf8")).toBe("created\n")
    await applied.rollback()
    expect(await readFile(tracked, "utf8")).toBe("before\n")
    expect(await Bun.file(created).exists()).toBe(false)

    const reapplied = await redos[0]!.apply()
    reapplied.commit()
    expect(await readFile(tracked, "utf8")).toBe("after\n")
    expect(await readFile(created, "utf8")).toBe("created\n")
  })
})

test("captures partial file changes when the tracked operation fails", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const undo = new WorkspaceUndo(workspace)
    const failure = new Error("tool exploded")
    undo.markPrompt("message-1", "Run a fallible tool")

    await expect(
      undo.trackPaths("edit", [tracked], async () => {
        await writeFile(tracked, "partial\n")
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await undo.previews()).toEqual([
      {
        messageId: "message-1",
        prompt: "Run a fallible tool",
        paths: ["tracked.txt"],
        codeAvailable: true,
      },
    ])

    const rewind = await undo.rewind("message-1")
    expect(await readFile(tracked, "utf8")).toBe("before\n")
    await rewind.rollback()
    expect(await readFile(tracked, "utf8")).toBe("partial\n")

    const repeated = await undo.rewind("message-1")
    repeated.commit()
    expect(await readFile(tracked, "utf8")).toBe("before\n")
  })
})

test("refuses to overwrite later worktree edits during rewind", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Make an agent edit")
    await undo.trackPaths("edit", [tracked], () => writeFile(tracked, "agent\n"))
    await writeFile(tracked, "later user edit\n")

    await expect(undo.rewind("message-1")).rejects.toThrow(
      "files from the last agent change were edited afterward; those edits were left intact.",
    )
    expect(await readFile(tracked, "utf8")).toBe("later user edit\n")
    expect((await undo.previews())[0]?.codeAvailable).toBe(true)
  })
})

test("refuses to rewind files staged after the tracked change", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Make an agent edit")
    await undo.trackPaths("edit", [tracked], () => writeFile(tracked, "agent\n"))
    await git(workspace, ["add", "tracked.txt"])

    await expect(undo.rewind("message-1")).rejects.toThrow(
      "Git index entries for the last agent change were staged afterward; the index and worktree were left intact.",
    )
    expect(await readFile(tracked, "utf8")).toBe("agent\n")
    expect(await git(workspace, ["show", ":tracked.txt"])).toBe("agent\n")
  })
})

test("runs an outside-workspace operation but invalidates prior code undo", async () => {
  await withGitWorkspace(async (workspace, root) => {
    const outside = join(root, "outside.txt")
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Write elsewhere")

    expect(await undo.trackPaths("write", [outside], async () => writeFile(outside, "outside\n"))).toBeUndefined()
    expect(await readFile(outside, "utf8")).toBe("outside\n")
    expect(await undo.previews()).toEqual([
      {
        messageId: "message-1",
        prompt: "Write elsewhere",
        paths: [],
        codeAvailable: false,
        unavailable: "write targeted a path outside the workspace, so full undo is unavailable",
      },
    ])
    await expect(undo.rewind("message-1")).rejects.toThrow(
      "write targeted a path outside the workspace, so full undo is unavailable",
    )
  })
})

test("preserves a shell command's staged changes while invalidating workspace undo", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Run a shell command")

    await undo.trackWorkspace("bash", async () => {
      await writeFile(tracked, "staged by command\n")
      await git(workspace, ["add", "tracked.txt"])
    })

    expect(await undo.previews()).toEqual([
      {
        messageId: "message-1",
        prompt: "Run a shell command",
        paths: [],
        codeAvailable: false,
        unavailable: "the Git index changed during a shell command, so full undo is unavailable",
      },
    ])
    expect(await readFile(tracked, "utf8")).toBe("staged by command\n")
    expect(await git(workspace, ["show", ":tracked.txt"])).toBe("staged by command\n")
  })
})

test("captures a same-size shell edit that keeps the timestamp Git cached", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    const cached = new Date(Date.now() - 60_000)
    await git(workspace, ["config", "core.trustctime", "false"])
    await utimes(tracked, cached, cached)
    await git(workspace, ["update-index", "--refresh"])
    await utimes(join(workspace, ".git", "index"), cached, cached)
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Run a shell command")

    await undo.trackWorkspace("bash", async () => {
      await writeFile(tracked, "racing\n")
      await utimes(tracked, cached, cached)
    })

    expect((await undo.previews())[0]?.paths).toEqual(["tracked.txt"])
    await undo.rewind("message-1")
    expect(await readFile(tracked, "utf8")).toBe("before\n")
  })
})

test("captures shell edits to files Git was told to assume unchanged", async () => {
  await withGitWorkspace(async (workspace) => {
    const tracked = join(workspace, "tracked.txt")
    await git(workspace, ["update-index", "--assume-unchanged", "tracked.txt"])
    const undo = new WorkspaceUndo(workspace)
    undo.markPrompt("message-1", "Run a shell command")

    await undo.trackWorkspace("bash", () => writeFile(tracked, "after\n"))

    expect((await undo.previews())[0]?.paths).toEqual(["tracked.txt"])
    await undo.rewind("message-1")
    expect(await readFile(tracked, "utf8")).toBe("before\n")
  })
})
