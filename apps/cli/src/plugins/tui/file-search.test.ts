import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { appInfo } from "../../app-info"
import { replaceSecretValues } from "../../secrets/redactor"
import { WorkspaceFileIndex } from "./file-search"

test("workspace index ranks files and directories without exposing secret paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), `${appInfo.name}-workspace-index-`))
  const index = new WorkspaceFileIndex()
  try {
    await mkdir(join(workspace, ".git"))
    await mkdir(join(workspace, "src", "nested"), { recursive: true })
    await mkdir(join(workspace, "apps"))
    await writeFile(join(workspace, "AGENTS.md"), "agents")
    await writeFile(join(workspace, "apps", "entry.ts"), "app")
    await writeFile(join(workspace, "Cargo.toml"), "cargo")
    await writeFile(join(workspace, "src", "nested", "visible-file.ts"), "visible")
    await writeFile(join(workspace, "src", "credential-secret.ts"), "secret")
    if (process.platform !== "win32") {
      await writeFile(join(workspace, "src", 'not"representable.ts'), "quote")
    }
    replaceSecretValues("workspace-index-test", ["credential-secret"])

    expect(await index.search(workspace, "visible")).toEqual([`src${sep}nested${sep}visible-file.ts`])
    const all = await index.search(workspace, "")
    expect(all?.slice(0, 4)).toEqual(["AGENTS.md", `apps${sep}`, `apps${sep}entry.ts`, "Cargo.toml"])
    expect(all).toContain(`src${sep}`)
    expect(all).toContain(`src${sep}nested${sep}`)
    expect(all?.some((path) => path.includes("credential-secret"))).toBe(false)
    expect(all?.some((path) => path.includes('"'))).toBe(false)
  } finally {
    index.clear()
    replaceSecretValues("workspace-index-test", [])
    await rm(workspace, { recursive: true, force: true })
  }
})
