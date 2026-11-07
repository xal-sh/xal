import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerHook, removeHooks } from "../../hooks/registry"
import type { AfterToolHookInput } from "../../hooks/types"
import type { StreamEvent } from "../../providers/types"
import { setUserRules } from "../../permissions/rules"
import { codeModeTool } from "../../plugins/code-mode/tool"
import { readTool } from "../../plugins/files/read"
import { writeTool } from "../../plugins/files/write"
import { replaceSecretValues } from "../../secrets/redactor"
import { registerTool, unregisterTool } from "../../tools/registry"
import { forgetFileStates } from "../../tools/file-state"
import { registerToolContextDisposer } from "../../tools/session"
import {
  completedRound,
  round,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
} from "./test-support"
import type { AgentSessionTestHarness } from "./test-support"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("read-authorization-")
  for (const tool of [readTool, writeTool, codeModeTool]) registerTool(tool)
  setUserRules({ allow: ["read(*)", "write(*)", "code_mode(*)"] })
  registerToolContextDisposer(forgetFileStates)
})

afterAll(async () => {
  for (const tool of [readTool, writeTool, codeModeTool]) unregisterTool(tool)
  setUserRules({})
  await harness.cleanup()
})

test("only unchanged direct model-visible reads authorize subsequent writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xal-visible-read-"))
  try {
    for (const mode of ["direct", "hook", "redaction", "bounded", "code-mode"]) {
      const path = join(cwd, `${mode}.txt`)
      const content = mode === "bounded" ? `${"猫".repeat(1000)}\n`.repeat(30) : "first\nprivate-fixture-value\nlast\n"
      await writeFile(path, content)
      if (mode === "hook") {
        registerHook("read-authorization-test", 0, 0, {
          name: "shorten-read",
          afterTool(input: AfterToolHookInput) {
            if (input.tool === "read") return { type: "replace", output: "some content was hidden" }
          },
        })
      }
      if (mode === "redaction") replaceSecretValues("read-authorization-test", ["private-fixture-value"])
      const provider = new ScriptedProvider([
        mode === "code-mode"
          ? toolRound("read", "code_mode", {
              code: `await callTool("read", {file_path: ${JSON.stringify(path)}}); emit("inspected");`,
            })
          : toolRound("read", "read", { file_path: path }),
        toolRound("write", "write", { file_path: path, content: "replacement\n" }),
        completedRound("done"),
      ])
      try {
        expect(
          (await runSettledTurn(harness.createSession(provider, { cwd }), { text: "Update", images: [] })).status,
        ).toBe("completed")
        const read = provider.requests[1]?.input.find((item) => item.type === "tool_result" && item.callId === "read")
        if (read?.type !== "tool_result") throw new Error("missing read result")
        if (mode === "hook") expect(read.output).toBe("some content was hidden")
        if (mode === "redaction") expect(read.output).toContain("[REDACTED]")
        if (mode === "bounded") expect(read.output).toContain("Full output saved to:")
        if (mode === "code-mode") expect(read.output).toStartWith("inspected")
        const output = provider.requests[2]?.input.find(
          (item) => item.type === "tool_result" && item.callId === "write",
        )
        if (output?.type !== "tool_result") throw new Error("missing write result")
        expect(output.output).toContain(mode === "direct" ? "Updated" : "has not been read completely")
        expect(await readFile(path, "utf8")).toBe(mode === "direct" ? "replacement\n" : content)
      } finally {
        removeHooks(0)
        replaceSecretValues("read-authorization-test", [])
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("automatic output offloading invalidates write authorization until a fresh direct read", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xal-offloaded-read-"))
  try {
    const path = join(cwd, "old.txt")
    const content = "original source line\n".repeat(1000)
    await writeFile(path, content)
    const paths = Array.from({ length: 12 }, (_, index) => join(cwd, `recent-${index}.txt`))
    await Promise.all(paths.map((file) => writeFile(file, "recent source\n")))
    const provider = new ScriptedProvider(
      [
        toolRound("old-read", "read", { file_path: path }),
        round([
          ...paths.map((file, index): StreamEvent => ({
            type: "item_done",
            item: { type: "tool_call", callId: `recent-${index}`, name: "read", args: { file_path: file } },
          })),
          { type: "done", usage: { totalInputTokens: 80_000 } },
        ]),
        toolRound("blocked-write", "write", { file_path: path, content: "must not be written" }),
        toolRound("fresh-read", "read", { file_path: path }),
        toolRound("allowed-write", "write", { file_path: path, content: "verified replacement\n" }),
        completedRound("done"),
      ],
      100_000,
      50_000,
    )
    const session = harness.createSession(provider, { cwd })
    expect((await runSettledTurn(session, { text: "Inspect and update", images: [] })).status).toBe("completed")
    expect(provider.requests).toHaveLength(6)
    expect(provider.requests.every((request) => request.toolChoice === "auto")).toBe(true)
    const results = provider.requests.at(-1)?.input.filter((item) => item.type === "tool_result")
    expect(results?.find((item) => item.callId === "old-read")?.output).toContain("Archived tool result:")
    expect(results?.find((item) => item.callId === "blocked-write")?.output).toContain("has not been read completely")
    expect(results?.find((item) => item.callId === "fresh-read")?.output).toContain("original source line")
    expect(results?.find((item) => item.callId === "allowed-write")?.output).toContain("Updated")
    expect(await readFile(path, "utf8")).toBe("verified replacement\n")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("round-budget shortening cannot authorize a write even within the same tool-call round", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xal-read-budget-"))
  try {
    const content = `${"x".repeat(40)}\n`.repeat(900)
    const paths = Array.from({ length: 5 }, (_, index) => join(cwd, `${index}.txt`))
    await Promise.all(paths.map((path) => writeFile(path, content)))
    const provider = new ScriptedProvider([
      round([
        ...paths.map((path, index): StreamEvent => ({
          type: "item_done",
          item: { type: "tool_call", callId: `read-${index}`, name: "read", args: { file_path: path } },
        })),
        {
          type: "item_done",
          item: { type: "tool_call", callId: "write", name: "write", args: { file_path: paths[0]!, content: "lost" } },
        },
        { type: "done" },
      ]),
      completedRound("done"),
    ])
    await runSettledTurn(harness.createSession(provider, { cwd }), { text: "Inspect and update", images: [] })
    const outputs = provider.requests[1]?.input.filter((item) => item.type === "tool_result")
    expect(outputs?.find((item) => item.callId === "read-0")?.output).toContain("Full output saved to:")
    expect(outputs?.find((item) => item.callId === "write")?.output).toContain("has not been read completely")
    expect(await readFile(paths[0]!, "utf8")).toBe(content)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
