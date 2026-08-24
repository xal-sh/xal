import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGit } from "../git/command"
import { captureWorkspaceTrust, workspaceDirty } from "./trust"

test("workspace trust snapshots roots and remote destinations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "xal-classifier-trust-"))
  try {
    await runGit(workspace, ["init"])
    await runGit(workspace, ["remote", "add", "origin", "git@example.com:team/repo.git"])
    const trust = await captureWorkspaceTrust(workspace)

    expect(trust.cwd).toBe(workspace)
    expect(trust.root).toBe(await realpath(workspace))
    expect(trust.remotes).toEqual(["git@example.com:team/repo.git"])

    await runGit(workspace, ["remote", "add", "later", "https://example.com/later.git"])
    expect(trust.remotes).toEqual(["git@example.com:team/repo.git"])
    expect((await captureWorkspaceTrust(workspace)).remotes).toEqual([
      "git@example.com:team/repo.git",
      "https://example.com/later.git",
    ])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("workspace trust reports current dirty state and preserves inherited remotes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "xal-classifier-dirty-"))
  try {
    await runGit(workspace, ["init"])
    expect(await workspaceDirty(workspace)).toBe(false)
    await writeFile(join(workspace, "new.txt"), "dirty\n")
    expect(await workspaceDirty(workspace)).toBe(true)

    const inherited = await captureWorkspaceTrust(workspace, ["parent-remote"])
    expect(inherited.remotes).toEqual(["parent-remote"])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
