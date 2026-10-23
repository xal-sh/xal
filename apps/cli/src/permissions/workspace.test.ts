import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar } from "../app-info"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
} from "../agent/session/test-support"
import { registerTool, unregisterTool } from "../tools/registry"
import { codeModeTool } from "../plugins/code-mode/tool"
import { editTool } from "../plugins/files/edit"
import { readTool } from "../plugins/files/read"
import { writeTool } from "../plugins/files/write"
import { globTool } from "../plugins/search/glob"
import { grepTool } from "../plugins/search/grep"
import { bashTool } from "../plugins/shell/bash/tool"
import { registerBashCtx } from "../plugins/shell/register-test-support"
import { sandboxAvailable } from "../plugins/shell/sandbox"
import type { RegisteredTool } from "../tools/types"
import { configureModes } from "./modes"
import { pathPermission } from "./path"
import { contributeRules, rememberRule, setUserRules } from "./rules"
import { evaluatePolicy } from "./service"
import { loadProjectRules } from "./store"
import type { PermissionRequest } from "./types"

const homeEnv = appEnvVar("HOME")
let previousHome: string | undefined
let root: string
let cwd: string
let sessionKey: object

beforeEach(async () => {
  previousHome = process.env[homeEnv]
  root = await realpath(await mkdtemp(join(tmpdir(), "xal-workspace-permissions-")))
  cwd = join(root, "workspace")
  sessionKey = {}
  process.env[homeEnv] = join(root, "home")
  await mkdir(cwd)
  await mkdir(join(root, "outside"))
  await writeFile(join(cwd, "inside.txt"), "inside")
  await writeFile(join(root, "outside", "secret.txt"), "outside")
  await symlink(join(root, "outside"), join(cwd, "linked"))
  await symlink(join(root, "outside", "missing.txt"), join(cwd, "dangling"))
  configureModes({ audit: { base: "plan", rules: {} }, guarded: { base: "normal", rules: {} } })
  setUserRules({})
})

afterEach(async () => {
  configureModes({})
  setUserRules({})
  if (previousHome === undefined) delete process.env[homeEnv]
  else process.env[homeEnv] = previousHome
  await rm(root, { recursive: true, force: true })
})

function request(tool: RegisteredTool, args: Record<string, unknown>, mode = "normal"): PermissionRequest {
  const permission = tool.permission?.(args, { cwd })
  return {
    sessionKey,
    cwd,
    tool: tool.name,
    title: tool.title(args, { cwd }),
    args,
    subject: permission?.subject,
    subjectAliases: permission?.subjectAliases,
    outsideWorkspace: permission?.outsideWorkspace,
    readOnly: tool.readOnly?.(args, { cwd }) ?? false,
    sandboxed: tool.sandboxed?.(args, { cwd }) ?? false,
    mode,
  }
}

test("file and search reads ask outside the working directory in normal, plan, and derived modes", async () => {
  for (const mode of ["normal", "plan", "guarded", "audit"]) {
    for (const tool of [readTool, globTool, grepTool]) {
      const key = tool === readTool ? "file_path" : "path"
      for (const path of ["../outside/secret.txt", join(root, "outside"), "linked/secret.txt", "~/", tmpdir()]) {
        expect(await evaluatePolicy(request(tool, { [key]: path }, mode))).toBe("ask")
      }
      expect(await evaluatePolicy(request(tool, { [key]: "inside.txt" }, mode))).toBe("allow")
      expect(await evaluatePolicy(request(tool, { [key]: join(cwd, "inside.txt") }, mode))).toBe("allow")
    }
    expect(await evaluatePolicy(request(globTool, { pattern: "**/*" }, mode))).toBe("allow")
    expect(await evaluatePolicy(request(grepTool, { pattern: "text" }, mode))).toBe("allow")
  }
})

test("path boundaries resolve symlinks, missing parents, home paths, and workspace aliases", async () => {
  expect(pathPermission("read", "linked/secret.txt", cwd)).toEqual({
    subject: join(root, "outside", "secret.txt"),
    subjectAliases: ["linked/secret.txt"],
    suggestion: `read(${root}/outside/*)`,
    outsideWorkspace: true,
  })
  expect(pathPermission("read", "~/", cwd).subject).toBe(await realpath(homedir()))
  expect(pathPermission("write", "dangling", cwd).subject).toBe(join(root, "outside", "missing.txt"))
  expect(pathPermission("write", "linked/new/nested/file.txt", cwd).outsideWorkspace).toBe(true)
  expect(pathPermission("write", "new/nested/file.txt", cwd).outsideWorkspace).toBe(false)
  expect(pathPermission("read", `${cwd}-other/file.txt`, cwd).outsideWorkspace).toBe(true)
  expect(pathPermission("read", "..local/file.txt", cwd).outsideWorkspace).toBe(false)
  await symlink(cwd, join(root, "alias"))
  expect(pathPermission("read", join(cwd, "inside.txt"), join(root, "alias")).outsideWorkspace).toBe(false)
  await symlink(join(cwd, "inside.txt"), join(cwd, "local-link"))
  expect(pathPermission("read", "local-link", cwd).outsideWorkspace).toBe(false)
  setUserRules({ ask: ["read(local-link)"] })
  expect(await evaluatePolicy(request(readTool, { file_path: "local-link" }))).toBe("ask")

  await symlink(join(cwd, "new"), join(root, "outside", "inward-link"))
  const target = `${root}/outside/inward-link/../secret.txt`
  for (const tool of [globTool, grepTool]) {
    expect(await evaluatePolicy(request(tool, { path: target }, "plan"))).toBe("ask")
  }
})

test("outside writes ask even for temporary or missing files, while plan and deny rules still block them", async () => {
  for (const tool of [writeTool, editTool]) {
    for (const file_path of ["../outside/new.txt", "linked/new/file.txt", "dangling", join(tmpdir(), "new.txt")]) {
      expect(await evaluatePolicy(request(tool, { file_path }))).toBe("ask")
      expect(await evaluatePolicy(request(tool, { file_path }, "plan"))).toBe("deny")
      expect(await evaluatePolicy(request(tool, { file_path }, "yolo"))).toBe("allow")
    }
    expect(await evaluatePolicy(request(tool, { file_path: "new/file.txt" }))).toBe("allow")
  }
  setUserRules({ allow: ["*"], deny: [`read(${root}/outside/*)`] })
  expect(await evaluatePolicy(request(readTool, { file_path: "linked/secret.txt" }, "yolo"))).toBe("deny")
  expect(await evaluatePolicy(request(writeTool, { file_path: "dangling" }, "plan"))).toBe("deny")
})

test("only explicit whitelists bypass outside approval and remembered rules stay scoped", async () => {
  const args = { file_path: "linked/secret.txt" }
  const permission = readTool.permission?.(args, { cwd })
  if (!permission?.suggestion) throw new Error("missing outside-read whitelist suggestion")
  contributeRules({ allow: [permission.suggestion] })
  expect(await evaluatePolicy(request(readTool, args))).toBe("ask")
  await rememberRule(sessionKey, cwd, permission.suggestion, "once")
  expect(await evaluatePolicy(request(readTool, args))).toBe("ask")
  await rememberRule(sessionKey, cwd, permission.suggestion, "session")
  expect(await evaluatePolicy(request(readTool, args, "plan"))).toBe("allow")
  expect(await evaluatePolicy({ ...request(readTool, args), sessionKey: {} })).toBe("ask")
  expect(await evaluatePolicy({ ...request(readTool, args), cwd: join(root, "other-project") })).toBe("ask")
  expect(await evaluatePolicy(request(writeTool, args))).toBe("ask")
  await rememberRule(sessionKey, cwd, permission.suggestion, "always")
  expect(await loadProjectRules(cwd)).toContain(permission.suggestion)
  expect(await evaluatePolicy({ ...request(readTool, args, "plan"), sessionKey: {} })).toBe("allow")
  setUserRules({ deny: [permission.suggestion] })
  expect(await evaluatePolicy(request(readTool, args))).toBe("deny")

  setUserRules({ deny: ["read(linked/*)"] })
  expect(await evaluatePolicy(request(readTool, args, "yolo"))).toBe("deny")

  const search = grepTool.permission?.({ path: "../outside" }, { cwd })
  expect(search?.suggestion).toBe(`grep(${root}/outside)`)
  setUserRules({ allow: [search!.suggestion!] })
  expect(await evaluatePolicy(request(grepTool, { path: "../outside" }, "plan"))).toBe("allow")
  expect(await evaluatePolicy(request(globTool, { path: "../outside" }, "plan"))).toBe("ask")
})

test.each(["normal", "plan"])("%s sessions ask before outside reads and honor the selected whitelist", async (mode) => {
  const harness = await setupAgentSessionTests("outside-read-approval-")
  const provider = new ScriptedProvider([
    toolRound("denied", "read", { file_path: "../outside/secret.txt" }),
    completedRound("Denied"),
    toolRound("approved", "read", { file_path: "linked/secret.txt" }),
    completedRound("Approved"),
    toolRound("remembered", "read", { file_path: "../outside/other.txt" }),
    completedRound("Remembered"),
  ])
  await writeFile(join(root, "outside", "other.txt"), "other")
  const session = harness.createSession(provider, { cwd, interactive: true })
  session.setMode(mode)
  registerTool(readTool)
  const approvals: string[] = []
  const outputs: string[] = []
  try {
    await runSettledTurn(session, { text: "Read the requested file", images: [] }, (event) => {
      if (event.type === "approval_requested") {
        approvals.push(event.callId)
        session.deny()
      }
      if (event.type === "tool_finished") outputs.push(event.output)
    })
    expect(approvals).toEqual(["denied"])
    expect(outputs[0]).toContain("denied")
    expect(outputs[0]).not.toContain("1: outside")
    for (let index = 0; index < 2; index++) {
      await runSettledTurn(session, { text: "Read the next file", images: [] }, (event) => {
        if (event.type === "approval_requested") {
          approvals.push(event.callId)
          expect(event.suggestion).toBe(`read(${root}/outside/*)`)
          session.approve("session", event.suggestion)
        }
        if (event.type === "tool_finished") outputs.push(event.output)
      })
    }
    expect(approvals).toEqual(["denied", "approved"])
    expect(outputs[1]).toContain("1: outside")
    expect(outputs[2]).toContain("1: other")
  } finally {
    unregisterTool(readTool)
    await harness.cleanup()
  }
})

test("Code Mode cannot bypass outside-read approval through an allowed parent tool", async () => {
  const harness = await setupAgentSessionTests("outside-code-mode-")
  const provider = new ScriptedProvider([
    toolRound("program", "code_mode", { code: 'emit(await callTool("read", { file_path: "linked/secret.txt" }))' }),
    completedRound("Done"),
  ])
  const session = harness.createSession(provider, { cwd, interactive: true })
  session.setMode("plan")
  setUserRules({ allow: ["code_mode"] })
  registerTool(codeModeTool)
  registerTool(readTool)
  const approvals: string[] = []
  const outputs: string[] = []
  try {
    await runSettledTurn(session, { text: "Inspect the file", images: [] }, (event) => {
      if (event.type === "approval_requested") {
        approvals.push(event.tool)
        session.deny()
      }
      if (event.type === "tool_finished") outputs.push(event.output)
    })
    expect(approvals).toEqual(["read"])
    expect(outputs.join("\n")).toContain("denied")
    expect(outputs.join("\n")).not.toContain("1: outside")
  } finally {
    unregisterTool(readTool)
    unregisterTool(codeModeTool)
    await harness.cleanup()
  }
})

test("shell approval cannot be bypassed by sandbox flags, dynamic paths, or persistent shell state", async () => {
  registerBashCtx()
  for (const command of [
    "cat ../outside/secret.txt",
    "cat < ../outside/secret.txt",
    "find .. -type f",
    "cat inside.txt",
    "printf first\ncat ../outside/secret.txt",
    'cat "$EXTERNAL_FILE"',
    "python3 -c 'open(\"../outside/secret.txt\").read()'",
  ]) {
    for (const sandbox of [undefined, "read", "workspace"]) {
      const args = { command, sandbox }
      expect(await evaluatePolicy(request(bashTool, args))).toBe("ask")
      expect(await evaluatePolicy(request(bashTool, args, "yolo"))).toBe("allow")
      expect(await evaluatePolicy(request(bashTool, args, "plan"))).toBe(
        sandbox === "read" && sandboxAvailable() ? "ask" : "deny",
      )
    }
  }
  const multiline = "if true; then\ncat ../outside/secret.txt\nfi"
  const suggestion = bashTool.permission?.({ command: multiline }, { cwd })?.suggestion
  if (!suggestion) throw new Error("missing shell whitelist suggestion")
  await rememberRule(sessionKey, cwd, suggestion, "session")
  expect(await evaluatePolicy(request(bashTool, { command: multiline }))).toBe("allow")

  setUserRules({ allow: ["bash(cat ../outside/secret.txt)"], deny: ["bash(rm *)"] })
  expect(await evaluatePolicy(request(bashTool, { command: "cat ../outside/secret.txt" }))).toBe("allow")
  expect(await evaluatePolicy(request(bashTool, { command: "cat ../outside/another.txt" }))).toBe("ask")
  expect(
    await evaluatePolicy(request(bashTool, { command: "cat inside.txt; rm ../outside/secret.txt", sandbox: "read" })),
  ).toBe("deny")
})
