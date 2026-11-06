import { expect, test } from "bun:test"
import type { AgentEvent } from "../agent/events"
import { redactAgentEvent } from "../secrets/data"
import { replaceSecretValues } from "../secrets/redactor"
import { parseRecord } from "../sessions/records"
import { parseVerificationSettings } from "./settings"
import type { VerificationRecord } from "./types"

test("validates opt-in check configuration without silently dropping commands", () => {
  expect(parseVerificationSettings(undefined)).toEqual({ checks: {}, gate: false })
  expect(parseVerificationSettings({ checks: { test: " bun test " } })).toEqual({
    checks: { test: "bun test" },
    gate: false,
  })
  expect(parseVerificationSettings({ checks: { test: "bun test" }, gate: true })).toEqual({
    checks: { test: "bun test" },
    gate: true,
  })
  for (const value of [
    null,
    [],
    { unknown: true },
    { "": true },
    { checks: [] },
    { checks: { Test: "true" } },
    { checks: { test: " " } },
    { checks: { test: 1 } },
    { checks: { test: "true", duplicate: " true " } },
    { gate: "yes" },
  ]) {
    expect(() => parseVerificationSettings(value)).toThrow()
  }
})

test("round-trips typed receipts and summaries and rejects incomplete wire evidence", () => {
  const started: VerificationRecord = {
    id: "run",
    name: "test",
    command: "bun test",
    cwd: "/workspace",
    startedAt: 1,
    status: "started",
  }
  const finished: VerificationRecord = {
    ...started,
    status: "finished",
    finishedAt: 2,
    execution: { status: "exited", exitCode: 0 },
    evidence: { status: "captured", fingerprint: "a".repeat(64) },
  }
  const events: AgentEvent[] = [
    { type: "verification_recorded", record: started },
    { type: "verification_recorded", record: finished },
    {
      type: "turn_ended",
      verification: [{ name: "test", command: "bun test", status: "passed", detail: "exit code 0" }],
    },
  ]
  for (const event of events)
    expect(parseRecord(JSON.stringify({ type: "event", event }))).toEqual({ type: "event", event })
  for (const record of [
    { ...finished, execution: undefined },
    { ...finished, evidence: undefined },
    { ...finished, evidence: { status: "captured", fingerprint: "bad" } },
    { ...finished, finishedAt: 0 },
  ]) {
    expect(() =>
      parseRecord(JSON.stringify({ type: "event", event: { type: "verification_recorded", record } })),
    ).toThrow("malformed session record")
  }
  expect(() =>
    parseRecord(
      JSON.stringify({
        type: "event",
        event: { type: "turn_ended", verification: [{ name: "test", status: "passed" }] },
      }),
    ),
  ).toThrow("malformed session record")
})

test("round-trips summaries when redaction makes check names identical", () => {
  replaceSecretValues("verification-collisions", ["alpha", "bravo"])
  try {
    const event = redactAgentEvent({
      type: "turn_ended",
      verification: [
        { name: "alpha", command: "true", status: "passed", detail: "exit code 0" },
        { name: "bravo", command: "false", status: "failed", detail: "exit code 1" },
      ],
    })
    expect(event).toMatchObject({ verification: [{ name: "[REDACTED]" }, { name: "[REDACTED]" }] })
    expect(parseRecord(JSON.stringify({ type: "event", event }))).toEqual({ type: "event", event })
  } finally {
    replaceSecretValues("verification-collisions", [])
  }
})

test("redacts receipt identities, evidence errors, and summaries before persistence", () => {
  const secret = "verification-secret-012345"
  replaceSecretValues("verification-test", [secret])
  try {
    const events: AgentEvent[] = [
      {
        type: "verification_recorded",
        record: {
          id: "run",
          name: "test",
          command: `echo ${secret}`,
          cwd: `/workspace/${secret}`,
          startedAt: 1,
          status: "finished",
          finishedAt: 2,
          execution: { status: "signaled", signal: secret },
          evidence: { status: "unavailable", reason: `cannot read ${secret}` },
        },
      },
      {
        type: "turn_ended",
        verification: [{ name: "test", command: `echo ${secret}`, status: "stale", detail: `cannot read ${secret}` }],
      },
    ]
    for (const event of events) {
      const redacted = redactAgentEvent(event)
      expect(JSON.stringify(redacted)).not.toContain(secret)
      expect(parseRecord(JSON.stringify({ type: "event", event: redacted }))).toEqual({
        type: "event",
        event: redacted,
      })
    }
  } finally {
    replaceSecretValues("verification-test", [])
  }
})
