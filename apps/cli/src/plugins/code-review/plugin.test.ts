import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { runGit } from "../../git/command"
import { nativeReviewDiff } from "../../native"

async function repository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `${appInfo.name}-review-diff-test-`))
  try {
    await runGit(root, ["init", "--initial-branch=main"])
    await runGit(root, ["config", "user.email", "test@example.com"])
    await runGit(root, ["config", "user.name", "Test"])
    await writeFile(join(root, "tracked.txt"), "before\n")
    await runGit(root, ["add", "."])
    await runGit(root, ["commit", "-m", "initial"])
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("formats native working-tree and branch review diffs", async () => {
  await repository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n")
    await runGit(root, ["add", "tracked.txt"])
    await writeFile(join(root, "tracked.txt"), "unstaged\n")
    await mkdir(join(root, "untracked"))
    await writeFile(join(root, "untracked", "note.txt"), "note\n")

    const working = await nativeReviewDiff({ cwd: root })
    expect(working.output).toContain("Git status:")
    expect(working.output).toContain("Staged diff:")
    expect(working.output).toContain("Unstaged diff:")
    expect(working.output).toContain("?? untracked/note.txt")

    const branch = await nativeReviewDiff({ cwd: root, base: "HEAD" })
    expect(branch.output).toContain("Base:")
    expect(branch.output).toContain("Merge base:")
    expect(branch.output).toContain("Diff:")
  })
})

test("rejects invalid or already-aborted native review requests", async () => {
  await repository(async (root) => {
    await expect(nativeReviewDiff({ cwd: root, base: "missing" })).rejects.toThrow("git rev-parse failed")
    const controller = new AbortController()
    controller.abort()
    await expect(nativeReviewDiff({ cwd: root, aborted: true }, controller.signal)).rejects.toThrow(
      "Git command interrupted",
    )
  })
})
