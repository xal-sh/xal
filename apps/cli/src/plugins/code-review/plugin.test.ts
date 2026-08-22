import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appInfo } from "../../app-info"
import { runGit } from "../../git/command"
import { reviewPrompt, workingTreeScope } from "./plugin"

async function repository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `${appInfo.name}-review-test-`))
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

test("directs working-tree reviews through normal Git and file tools", async () => {
  await repository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "after\n")
    await writeFile(join(root, "untracked.txt"), "new\n")

    const scope = await workingTreeScope(root)
    expect(scope).toBeDefined()
    if (!scope) throw new Error("expected review scope")

    const prompt = reviewPrompt(scope)
    expect(prompt).toContain("`git diff --cached --no-ext-diff --find-renames --`")
    expect(prompt).toContain("`git diff --no-ext-diff --find-renames --`")
    expect(prompt).toContain("?? untracked.txt")
    expect(prompt).not.toContain("review_diff")
  })
})
