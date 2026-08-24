import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionRequest } from "../../permissions/types"
import { filePolicy, pathPermission } from "./permission"

function request(tool: string, filePath: string, cwd = "/workspace"): PermissionRequest {
  return {
    sessionKey: {},
    cwd,
    tool,
    title: filePath,
    args: { file_path: filePath },
    subject: filePath,
    readOnly: tool === "read",
    sandboxed: false,
    mode: "normal",
  }
}

test("file policy fast-paths workspace and temporary edits", () => {
  expect(filePolicy(request("write", "src/index.ts"))).toBe("allow")
  expect(filePolicy(request("edit", "/workspace/src/index.ts"))).toBe("allow")
  expect(filePolicy(request("write", join(tmpdir(), "generated.txt")))).toBe("allow")
  expect(filePolicy(request("edit", "/tmp/generated.txt"))).toBe("allow")
})

test("file policy classifies workspace symlinks that escape or alias sensitive files", async () => {
  const root = await mkdtemp(join(process.cwd(), ".xal-file-policy-"))
  const workspace = join(root, "workspace")
  const outside = join(root, "outside")
  try {
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, ".env"), "SECRET=value\n")
    await symlink(outside, join(workspace, "external"))
    await symlink(join(outside, ".env"), join(workspace, "settings.txt"))

    expect(filePolicy(request("write", "external/result.txt", workspace))).toBe("classify")
    expect(filePolicy(request("edit", "external/.env", workspace))).toBe("classify")
    expect(filePolicy(request("read", "settings.txt", workspace))).toBe("classify")
    expect(pathPermission("write", { file_path: "external/result.txt" }, workspace).subject).toBe(
      join(outside, "result.txt"),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file policy classifies external edits and sensitive reads", () => {
  expect(filePolicy(request("write", "/outside/result.txt"))).toBe("classify")
  expect(filePolicy(request("edit", "../outside/result.txt"))).toBe("classify")
  expect(filePolicy(request("read", ".env"))).toBe("classify")
  expect(filePolicy(request("read", "config/.env.production"))).toBe("classify")
  expect(filePolicy(request("read", "src/index.ts"))).toBeUndefined()
})
