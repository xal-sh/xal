import { expect, test } from "bun:test"
import { agentSteerDecision, mainFooterHeight } from "./screen"

test("live tools fill the gap between scrollback and the fixed footer", () => {
  expect(mainFooterHeight(40, 12, 8, 1)).toBe(28)
})

test("live tools stay attached as completed rows enter scrollback", () => {
  expect(mainFooterHeight(40, 13, 8, 1)).toBe(27)
})

test("the footer returns to its content height without live tools", () => {
  expect(mainFooterHeight(40, 12, 8, 0)).toBe(8)
})

test("image steering is rejected with an error even for a steerable agent", () => {
  expect(agentSteerDecision(true, { text: "look", images: [{ mediaType: "image/png", data: "x" }] })).toEqual({
    kind: "error",
    message: "image input is not available while steering a task agent",
  })
})

test("an agent that is not accepting input bounces with a notice", () => {
  expect(agentSteerDecision(false, { text: "hello", images: [] })).toEqual({ kind: "bounce" })
})

test("text steering for a running agent is sent", () => {
  expect(agentSteerDecision(true, { text: "hello", images: [] })).toEqual({ kind: "send" })
})
