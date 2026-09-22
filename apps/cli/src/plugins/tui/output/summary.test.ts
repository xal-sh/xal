import { expect, test } from "bun:test"
import { describeToolFailure } from "./summary"

test("names why a tool failed instead of reporting a bare failure", () => {
  expect(describeToolFailure("", { status: "exited", exitCode: 1 })).toBe("exit 1")
  expect(describeToolFailure("", { status: "timed_out", timeoutSeconds: 120 })).toBe("timed out · 120s")
  expect(describeToolFailure("", { status: "signaled", signal: "SIGKILL" })).toBe("killed · SIGKILL")
  expect(describeToolFailure("", { status: "signaled" })).toBe("killed")
  expect(describeToolFailure("", { status: "interrupted" })).toBe("interrupted")
  expect(describeToolFailure("Tool failed: old_string not found in src/app.ts, so nothing changed.")).toBe(
    "old_string not found in src…",
  )
  expect(
    describeToolFailure("Tool completed, but its output could not be saved: disk full", {
      status: "exited",
      exitCode: 0,
    }),
  ).toBe("disk full")
  expect(describeToolFailure("nope\n(exit code 2)")).toBe("exit 2")
  expect(describeToolFailure("something unhelpful")).toBe("failed")
})
