import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { changedFiles } from "./changed-files"
import { runGit } from "./command"

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "xal-changed-files-")))
})

afterEach(() => rm(root, { recursive: true, force: true }))

test("lists staged, unstaged, renamed, and untracked files from the repository root", async () => {
  const signal = new AbortController().signal
  expect(await changedFiles(root, signal)).toEqual([])
  await runGit(root, ["init", "--quiet"])
  await mkdir(join(root, "src/nested"), { recursive: true })
  await writeFile(join(root, "src/old.ts"), "old\n")
  await writeFile(join(root, "src/kept.ts"), "kept\n")
  await runGit(root, ["add", "."])
  await runGit(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"])
  await runGit(root, ["mv", "src/old.ts", "src/new.ts"])
  await writeFile(join(root, "src/kept.ts"), "changed\n")
  await writeFile(join(root, "src/nested/fresh.ts"), "fresh\n")
  await writeFile(join(root, "src/with space.ts"), "spaced\n")
  expect((await changedFiles(join(root, "src/nested"), signal)).toSorted()).toEqual([
    join(root, "src/kept.ts"),
    join(root, "src/nested/fresh.ts"),
    join(root, "src/new.ts"),
    join(root, "src/with space.ts"),
  ])
})
