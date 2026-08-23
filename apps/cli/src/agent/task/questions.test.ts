import { expect, test } from "bun:test"
import { createParentQuestionChannel, type AgentQuestion, type ParentQuestionResult } from "./questions"

function channelHarness() {
  const delivered: AgentQuestion[] = []
  const settled: string[] = []
  const resumed: ParentQuestionResult[] = []
  const channel = createParentQuestionChannel({
    jobId: () => "child-1",
    deliver: (question) => {
      delivered.push(question)
      return true
    },
    settled: (requestId) => settled.push(requestId),
    waiting: () => {},
    resumed: (result) => resumed.push(result),
  })
  return { channel, delivered, settled, resumed }
}

test("blocks one parent question until it is answered exactly once", async () => {
  const harness = channelHarness()
  const pending = harness.channel.ask("Which target should I use?", new AbortController().signal)

  expect(harness.channel.pending()).toBe(true)
  expect(harness.delivered).toHaveLength(1)
  const requestId = harness.delivered[0]?.requestId
  if (!requestId) throw new Error("question was not delivered")
  expect(harness.channel.answer("Use the release target.")).toBe(requestId)
  expect(harness.channel.answer("duplicate")).toBeUndefined()

  expect(await pending).toEqual({ status: "answered", answer: "Use the release target." })
  expect(harness.settled).toEqual([requestId])
  expect(harness.resumed).toEqual([{ status: "answered", answer: "Use the release target." }])
})

test("rejects a second pending question and releases the first on cancellation", async () => {
  const harness = channelHarness()
  const controller = new AbortController()
  const pending = harness.channel.ask("Need a decision", controller.signal)

  await expect(harness.channel.ask("Another decision", new AbortController().signal)).rejects.toThrow("already pending")
  controller.abort()

  expect(await pending).toEqual({ status: "unavailable", reason: "the task was canceled" })
  expect(harness.channel.pending()).toBe(false)
  expect(harness.settled).toHaveLength(1)
})

test("settles unavailable when the parent rejects delivery", async () => {
  const channel = createParentQuestionChannel({
    jobId: () => "child-1",
    deliver: () => false,
    settled: () => {},
    waiting: () => {},
    resumed: () => {},
  })

  await expect(channel.ask("Need context", new AbortController().signal)).resolves.toEqual({
    status: "unavailable",
    reason: "the parent is unavailable",
  })
})
