import { expect, test } from "bun:test"
import type { PromptContext } from "../agent/prompt/registry"
import { composeSystemPrompt } from "../agent/prompt/registry"
import type { Settings } from "../config/settings"
import { registerPermissions } from "./register"

function prompt(mode: string): PromptContext {
  return {
    sessionId: "session",
    appName: "Xal",
    platform: "test",
    cwd: "/workspace",
    kind: "primary",
    tools: [],
    mode,
  }
}

test("makes the current writable mode override stale plan-mode context", () => {
  registerPermissions({
    plugins: [],
    permissions: { allow: [], ask: [], deny: [] },
    modes: {
      guarded: {
        base: "normal",
        allow: [],
        ask: [],
        deny: [],
        guidance: "Use the guarded workflow.",
      },
    },
    goal: { evaluatorModels: {} },
    redaction: { values: [], environment: [] },
    agents: { maxConcurrent: 4, timeoutMinutes: 0, maxTurns: 24 },
    pluginConfig: {},
    thinking: {},
    contextWindows: {},
    compactionLimits: {},
  } satisfies Settings)

  const yolo = composeSystemPrompt(prompt("yolo"))
  const custom = composeSystemPrompt(prompt("guarded"))
  const plan = composeSystemPrompt(prompt("plan"))

  expect(yolo).toContain("Current permission mode is `yolo`. Plan mode is not active")
  expect(yolo).toContain("do not claim that plan-mode restrictions block tools or file writes")
  expect(custom).toContain("Current permission mode is `guarded`. Plan mode is not active")
  expect(custom).toContain("Use the guarded workflow.")
  expect(plan).toContain("Current permission mode is `plan` and it is read-only.")
  expect(plan).not.toContain("Plan mode is not active")
})
