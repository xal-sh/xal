import { expect, test } from "bun:test"
import { renderSessionMarkdown } from "./export"
import { parseRecord } from "./records"

test("classifier denials round trip and remain visible in exports", () => {
  const record = parseRecord(
    JSON.stringify({
      type: "event",
      event: {
        type: "tool_finished",
        callId: "blocked-call",
        tool: "bash",
        title: "git push --force origin main",
        readOnly: false,
        output: "Safety classifier blocked this action: force push was not requested.",
        denial: "classifier",
      },
    }),
  )
  expect(record.type).toBe("event")
  if (record.type !== "event" || record.event.type !== "tool_finished") throw new Error("unexpected parsed record")
  expect(record.event.denial).toBe("classifier")

  const markdown = renderSessionMarkdown({
    meta: {
      version: 2,
      id: "session",
      cwd: "/workspace",
      provider: "provider",
      model: "model",
      mode: "normal",
      startedAt: 0,
    },
    events: [record.event],
  })
  expect(markdown).toContain("Safety classifier blocked this action")
  expect(markdown).toContain("git push --force origin main")
})
