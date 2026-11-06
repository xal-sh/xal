import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { disposeToolSession } from "../../tools/session"
import { composeSystemPrompt } from "./registry"
import { captureWorkspaceContext, registerWorkspacePrompt } from "./workspace"

registerWorkspacePrompt()

const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xal-workspace-prompt-"))
  directories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.email=test@xal.test", "-c", "user.name=Xal Test", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await proc.exited) !== 0) throw new Error(`git ${args[0]} failed`)
}

function prompt(sessionId: string, cwd: string): string {
  return composeSystemPrompt({
    sessionId,
    appName: "Xal",
    platform: "test",
    cwd,
    kind: "primary",
    tools: [],
    mode: "normal",
  })
}

test("snapshots the date, branch, changes, and recent commits once per session workspace", async () => {
  const cwd = await workspace()
  await git(cwd, ["init", "-q", "-b", "main"])
  await writeFile(join(cwd, "tracked.txt"), "one\n")
  await writeFile(join(cwd, "old name.txt"), "moved\n")
  await git(cwd, ["add", "-A"])
  await git(cwd, ["commit", "-qm", "Seed the repository"])
  await writeFile(join(cwd, "tracked.txt"), "two\n")
  await writeFile(join(cwd, "new file.txt"), "new\n")
  await git(cwd, ["mv", "old name.txt", "new name.txt"])
  const sessionId = crypto.randomUUID()

  await captureWorkspaceContext(sessionId, cwd, new AbortController().signal)
  const captured = prompt(sessionId, cwd)
  expect(captured).toMatch(/^Date: \d{4}-\d{2}-\d{2}\.\nGit at session start: branch main, 3 changed paths\.\n/)
  expect(captured).toContain("\nR  old name.txt -> new name.txt\n")
  expect(captured).toContain("\n M tracked.txt\n")
  expect(captured).toContain("\n?? new file.txt\n")
  expect(captured).toMatch(/Recent commits:\n[0-9a-f]+ Seed the repository$/)

  await writeFile(join(cwd, "later.txt"), "later\n")
  await captureWorkspaceContext(sessionId, cwd, new AbortController().signal)
  expect(prompt(sessionId, cwd)).toBe(captured)
  expect(prompt(sessionId, join(cwd, "elsewhere"))).toBe("")

  disposeToolSession(sessionId)
  expect(prompt(sessionId, cwd)).toBe("")
})

test("states only the date outside a repository and a clean tree before the first commit", async () => {
  const plain = await workspace()
  const plainSession = crypto.randomUUID()
  await captureWorkspaceContext(plainSession, plain, new AbortController().signal)
  expect(prompt(plainSession, plain)).toMatch(/^Date: \d{4}-\d{2}-\d{2}\.$/)

  const empty = await workspace()
  await git(empty, ["init", "-q", "-b", "trunk"])
  const emptySession = crypto.randomUUID()
  await captureWorkspaceContext(emptySession, empty, new AbortController().signal)
  expect(prompt(emptySession, empty)).toMatch(/^Date: .+\nGit at session start: branch trunk, clean working tree\.$/)
})

test("lists at most 20 changes, collapses untracked directories, and drops captures of disposed sessions", async () => {
  const cwd = await workspace()
  await git(cwd, ["init", "-q", "-b", "main"])
  await git(cwd, ["config", "status.showUntrackedFiles", "all"])
  await mkdir(join(cwd, "untracked"))
  await writeFile(join(cwd, "untracked", "inside.txt"), "inside\n")
  await Promise.all(Array.from({ length: 22 }, (_, index) => writeFile(join(cwd, `file-${index}.txt`), "new\n")))
  const sessionId = crypto.randomUUID()

  await captureWorkspaceContext(sessionId, cwd, new AbortController().signal)
  const captured = prompt(sessionId, cwd)
  expect(captured).toContain("Git at session start: branch main, 23 changed paths.")
  expect(captured).not.toContain("inside.txt")
  expect(captured.split("\n").filter((line) => line.startsWith("?? "))).toHaveLength(20)
  expect(captured).toEndWith("\n... 3 more")

  const disposed = crypto.randomUUID()
  const pending = captureWorkspaceContext(disposed, cwd, new AbortController().signal)
  disposeToolSession(disposed)
  await pending
  expect(prompt(disposed, cwd)).toBe("")
})
