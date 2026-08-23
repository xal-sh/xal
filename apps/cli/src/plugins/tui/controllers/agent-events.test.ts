import { expect, test } from "bun:test"
import { agentQuestionNotice } from "./agent-events"

const question = {
  requestId: "question-1",
  jobId: "child-1",
  question: "Which target should I use?",
}

test("renders live task-agent questions as actionable notices", () => {
  expect(agentQuestionNotice(question, false)).toEqual({
    kind: "notice",
    summary: "task agent child-1 is waiting for an answer",
    details: ["Which target should I use?", "Reply with job_send to child-1."],
  })
})

test("renders replayed task-agent questions as historical notices", () => {
  expect(agentQuestionNotice(question, true)).toEqual({
    kind: "notice",
    summary: "historical task-agent question from child-1",
    details: ["Which target should I use?", "This historical question is no longer actionable."],
  })
})
