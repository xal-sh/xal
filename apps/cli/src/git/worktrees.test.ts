import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { runGit } from "./command"
import { createManagedWorktree, managedWorktreeAt, removeManagedWorktree, unmanageWorktree } from "./worktrees"

interface Repository {
  root: string
  nested: string
}

async function withRepository(run: (repository: Repository) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${appInfo.name}-worktree-test-`))
  const homeEnv = appEnvVar("HOME")
  const inheritedHome = process.env[homeEnv]
  process.env[homeEnv] = join(directory, "home")
  const root = join(directory, "repo")
  const nested = join(root, "packages", "app")
  try {
    await mkdir(nested, { recursive: true })
    await runGit(root, ["init", "--initial-branch=main"])
    await runGit(root, ["config", "user.email", "test@example.com"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(nested, "index.ts"), "export const value = 1\n")
    await runGit(root, ["add", "."])
    await runGit(root, ["commit", "-m", "initial"])
    await run({ root, nested })
  } finally {
    if (inheritedHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = inheritedHome
    await rm(directory, { recursive: true, force: true })
  }
}

async function markerPath(worktreePath: string): Promise<string> {
  const gitDir = await runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir"])
  return join(gitDir, `${appInfo.name}-worktree.json`)
}

test("creates an isolated worktree at HEAD and maps the caller's subdirectory into it", async () => {
  await withRepository(async ({ root, nested }) => {
    const head = await runGit(root, ["rev-parse", "HEAD"])

    const worktree = await createManagedWorktree(nested, "Fix Login Bug")

    expect(worktree.baseCommit).toBe(head)
    expect(worktree.branch.startsWith(`${appInfo.name}/fix-login-bug-`)).toBe(true)
    expect(worktree.cwd).toBe(join(worktree.path, "packages", "app"))
    expect(await readFile(join(worktree.cwd, "index.ts"), "utf8")).toBe("export const value = 1\n")
    expect(await runGit(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(worktree.branch)
    expect(await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")

    expect(await managedWorktreeAt(worktree.path)).toEqual(worktree)
    expect(await managedWorktreeAt(worktree.cwd)).toEqual(worktree)
    expect(await managedWorktreeAt(root)).toBeUndefined()
  })
})

test("refuses to create a worktree while the workspace has uncommitted changes", async () => {
  await withRepository(async ({ nested }) => {
    await writeFile(join(nested, "scratch.ts"), "draft\n")

    await expect(createManagedWorktree(nested, "risky")).rejects.toThrow("workspace has uncommitted changes")
  })
})

test("gives each worktree its own branch and directory", async () => {
  await withRepository(async ({ root }) => {
    const first = await createManagedWorktree(root, "review")
    const second = await createManagedWorktree(root, "review")

    expect(first.branch).not.toBe(second.branch)
    expect(first.path).not.toBe(second.path)
    expect(await managedWorktreeAt(first.path)).toEqual(first)
    expect(await managedWorktreeAt(second.path)).toEqual(second)
  })
})

test("keeps a worktree holding uncommitted work unless removal is forced", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "wip")
    await writeFile(join(worktree.path, "notes.md"), "unsaved\n")

    await expect(removeManagedWorktree(worktree, false)).rejects.toThrow("uncommitted or ignored files")
    expect(await managedWorktreeAt(worktree.path)).toEqual(worktree)

    await removeManagedWorktree(worktree, true)

    expect(await runGit(root, ["worktree", "list", "--porcelain"])).not.toContain(worktree.path)
  })
})

test("removes a clean worktree without forcing", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "clean")

    await removeManagedWorktree(worktree, false)

    expect(await runGit(root, ["worktree", "list", "--porcelain"])).not.toContain(worktree.path)
  })
})

test("refuses managed operations on a worktree it does not manage", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "adopted")

    await unmanageWorktree(worktree)

    expect(await managedWorktreeAt(worktree.path)).toBeUndefined()
    await expect(removeManagedWorktree(worktree, false)).rejects.toThrow(`is not a managed ${appInfo.displayName}`)
    await expect(unmanageWorktree(worktree)).rejects.toThrow(`is not a managed ${appInfo.displayName}`)
    expect(await runGit(root, ["worktree", "list", "--porcelain"])).toContain(worktree.path)
  })
})

test("rejects a marker that does not describe the checkout holding it", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "moved")
    await writeFile(await markerPath(root), JSON.stringify(worktree))

    await expect(managedWorktreeAt(root)).rejects.toThrow("managed worktree marker does not match")
  })
})

test("rejects malformed marker syntax with recovery guidance", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "syntax")
    await writeFile(await markerPath(worktree.path), "{broken")

    await expect(managedWorktreeAt(worktree.path)).rejects.toThrow("is malformed — fix or delete it")
  })
})

test("rejects a malformed marker instead of ignoring it", async () => {
  await withRepository(async ({ root }) => {
    const worktree = await createManagedWorktree(root, "corrupt")
    await writeFile(await markerPath(worktree.path), JSON.stringify({ version: 1, path: "relative/path" }))

    await expect(managedWorktreeAt(worktree.path)).rejects.toThrow("invalid managed worktree record")
  })
})

test("honors already-aborted worktree operations", async () => {
  await withRepository(async ({ root }) => {
    const controller = new AbortController()
    controller.abort()

    await expect(managedWorktreeAt(root, controller.signal)).rejects.toThrow("Git command interrupted")
    await expect(createManagedWorktree(root, "cancelled", controller.signal)).rejects.toThrow(
      "Worktree creation interrupted",
    )
  })
})

test("rolls back branch and checkout when worktree checkout fails", async () => {
  await withRepository(async ({ root }) => {
    await writeFile(join(root, ".gitattributes"), "*.ts filter=broken\n")
    await runGit(root, ["add", ".gitattributes"])
    await runGit(root, ["commit", "-m", "require filter"])
    await runGit(root, ["config", "filter.broken.clean", "cat"])
    await runGit(root, ["config", "filter.broken.smudge", "false"])
    await runGit(root, ["config", "filter.broken.required", "true"])

    await expect(createManagedWorktree(root, "broken-checkout")).rejects.toThrow()
    expect(await runGit(root, ["branch", "--list", `${appInfo.name}/broken-checkout-*`])).toBe("")
    expect((await runGit(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(1)
  })
})
