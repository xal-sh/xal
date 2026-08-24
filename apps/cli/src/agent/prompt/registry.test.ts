import { expect, test } from "bun:test"
import { composeClassifierGuidance, composeSystemPrompt, registerPrompt, type PromptContext } from "./registry"

const context: PromptContext = {
  sessionId: "session",
  appName: "Xal",
  platform: "test",
  cwd: "/workspace",
  kind: "primary",
  tools: [],
  mode: "normal",
}

test("classifier guidance includes only explicitly trusted prompt sections", () => {
  registerPrompt({ id: "trusted-test", classifierTrusted: true, text: () => "TRUSTED_PROJECT_GUIDANCE" })
  registerPrompt({ id: "mcp-test", classifierTrusted: false, text: () => "HOSTILE_MCP_INSTRUCTION" })
  registerPrompt({ id: "memory-test", text: () => "MODEL_WRITABLE_MEMORY" })

  expect(composeSystemPrompt(context)).toContain("TRUSTED_PROJECT_GUIDANCE")
  expect(composeSystemPrompt(context)).toContain("HOSTILE_MCP_INSTRUCTION")
  expect(composeSystemPrompt(context)).toContain("MODEL_WRITABLE_MEMORY")
  expect(composeClassifierGuidance(context)).toContain("TRUSTED_PROJECT_GUIDANCE")
  expect(composeClassifierGuidance(context)).not.toContain("HOSTILE_MCP_INSTRUCTION")
  expect(composeClassifierGuidance(context)).not.toContain("MODEL_WRITABLE_MEMORY")
})
