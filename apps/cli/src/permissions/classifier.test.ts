import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appEnvVar, appInfo } from "../app-info"
import { completedRound, round, ScriptedProvider } from "../agent/session/test-support"
import { startProfiler, stopProfiler } from "../profiler/profiler"
import { protectSecretValue } from "../secrets/redactor"
import { classifyPermission, parseClassifierVerdict } from "./classifier"
import type { ClassifierContext } from "./context"

const context: ClassifierContext = {
  guidance: "Keep changes inside the workspace.",
  userMessages: ["Run the requested checks."],
  priorActions: [],
  workspace: { cwd: "/workspace", root: "/workspace", remotes: ["git@example.com:team/repo.git"], dirty: false },
  pendingAction: {
    tool: "bash",
    title: "bun test",
    args: { command: "bun test" },
    subject: "bun test",
    readOnly: false,
    sandboxed: false,
    origin: "model",
  },
}

test("permission verdict parser accepts only the exact contract", () => {
  expect(parseClassifierVerdict({ verdict: "allow", reason: "Requested test run" })).toEqual({
    verdict: "allow",
    reason: "Requested test run",
  })
  expect(parseClassifierVerdict({ verdict: "block", reason: "External upload" })).toEqual({
    verdict: "block",
    reason: "External upload",
  })
  expect(parseClassifierVerdict({ verdict: "allow", reason: "" })).toBeUndefined()
  expect(parseClassifierVerdict({ verdict: "approve", reason: "Looks fine" })).toBeUndefined()
  expect(parseClassifierVerdict({ verdict: "allow", reason: "Fine", extra: true })).toBeUndefined()
  expect(parseClassifierVerdict(["allow"])).toBeUndefined()

  const secret = `classifier-secret-${crypto.randomUUID()}`
  protectSecretValue(secret)
  const redacted = parseClassifierVerdict({ verdict: "block", reason: `Would expose ${secret}` })
  expect(redacted?.reason).not.toContain(secret)

  const bounded = parseClassifierVerdict({ verdict: "block", reason: "x".repeat(10_000) })
  expect(bounded?.reason.length).toBeLessThanOrEqual(2_001)
})

test("permission classifier is tool-free and uses the session model", async () => {
  const provider = new ScriptedProvider([completedRound('{"verdict":"allow","reason":"Requested local tests"}')])
  const result = await classifyPermission({
    provider,
    profileId: "test-profile",
    model: "test-model",
    sessionId: "session",
    kind: "primary",
    signal: new AbortController().signal,
    context,
  })

  expect(result.verdict).toEqual({ verdict: "allow", reason: "Requested local tests" })
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0]?.tools).toEqual([])
  expect(provider.requests[0]?.toolChoice).toBe("none")
  expect(provider.requests[0]?.model).toBe("test-model")
})

test("permission classifier rejects malformed, failed, and interrupted responses", async () => {
  const malformed = new ScriptedProvider([completedRound("not json")])
  await expect(
    classifyPermission({
      provider: malformed,
      profileId: "test-profile",
      model: "test-model",
      sessionId: "session",
      kind: "primary",
      signal: new AbortController().signal,
      context,
    }),
  ).rejects.toThrow("malformed permission verdict")

  const failed = new ScriptedProvider([round([], new Error("provider unavailable"))])
  await expect(
    classifyPermission({
      provider: failed,
      profileId: "test-profile",
      model: "test-model",
      sessionId: "session",
      kind: "primary",
      signal: new AbortController().signal,
      context,
    }),
  ).rejects.toThrow("provider unavailable")

  const controller = new AbortController()
  controller.abort()
  const interrupted = new ScriptedProvider([round([], new DOMException("stopped", "AbortError"))])
  await expect(
    classifyPermission({
      provider: interrupted,
      profileId: "test-profile",
      model: "test-model",
      sessionId: "session",
      kind: "primary",
      signal: controller.signal,
      context,
    }),
  ).rejects.toThrow("stopped")
})

test("malformed permission verdicts finish profiler requests as failed", async () => {
  const homeEnv = appEnvVar("HOME")
  const previousHome = process.env[homeEnv]
  const home = await mkdtemp(join(tmpdir(), `${appInfo.name}-classifier-profile-`))
  process.env[homeEnv] = home
  startProfiler(true)
  try {
    const provider = new ScriptedProvider([
      completedRound("malformed classifier response", { totalInputTokens: 10, outputTokens: 2 }),
    ])
    await expect(
      classifyPermission({
        provider,
        profileId: "test-profile",
        model: "test-model",
        sessionId: "session",
        kind: "primary",
        signal: new AbortController().signal,
        context,
      }),
    ).rejects.toThrow("malformed permission verdict")

    const path = await stopProfiler()
    if (!path) throw new Error("classifier profiler output was not written")
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
    const started = records.find(
      (record) =>
        typeof record === "object" && record !== null && "type" in record && record.type === "provider_request_started",
    )
    const finished = records.find(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "type" in record &&
        record.type === "provider_request_finished",
    )
    expect(started).toMatchObject({ phase: "permission_classification" })
    expect(finished).toMatchObject({ outcome: "failed", usage: { totalInputTokens: 10, outputTokens: 2 } })
    expect(JSON.stringify(records)).not.toContain("malformed classifier response")
  } finally {
    await stopProfiler()
    if (previousHome === undefined) delete process.env[homeEnv]
    else process.env[homeEnv] = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
