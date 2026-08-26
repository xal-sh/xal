import { expect, test } from "bun:test"
import { round, ScriptedProvider } from "../agent/session/test-support"
import { evaluateGoal } from "./evaluator"

test("omits retained images when the evaluator model is text-only", async () => {
  const provider = new ScriptedProvider([
    round([
      {
        type: "item_done",
        item: {
          type: "assistant_message",
          text: JSON.stringify({ verdict: "not_yet_met", reason: "More evidence is needed." }),
        },
      },
      { type: "done" },
    ]),
  ])

  const result = await evaluateGoal({
    provider,
    profileId: "test-profile",
    sessionModel: "vision-model",
    evaluatorModel: "text-model",
    thinking: undefined,
    imageInput: false,
    conversation: [
      {
        type: "user_message",
        text: "Inspect this",
        images: [{ mediaType: "image/jpeg", data: "retained-image" }],
      },
    ],
    sessionId: "goal-session",
    signal: new AbortController().signal,
    condition: "The issue is fixed",
  })

  expect(result.verdict).toEqual({ verdict: "not_yet_met", reason: "More evidence is needed." })
  expect(provider.requests[0]?.input[0]).toEqual({
    type: "user_message",
    text: "Inspect this\n\n[1 image attachment omitted]",
    images: [],
  })
})
