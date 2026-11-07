import { describe, expect, test } from "bun:test"
import { ContextOverflowError } from "../../providers/errors"
import { raiseForStatus } from "./api-client"

describe("OpenAI HTTP errors", () => {
  test("retains structured context codes through the public status handler", async () => {
    const response = Response.json(
      { error: { code: "context_length_exceeded", message: "request rejected" } },
      { status: 400 },
    )
    await expect(raiseForStatus(response)).rejects.toBeInstanceOf(ContextOverflowError)
  })

  test("preserves authentication and access error messages", async () => {
    await expect(raiseForStatus(new Response("prompt is too long", { status: 401 }))).rejects.toMatchObject({
      message: "OpenAI API authentication failed; reconnect the provider",
      retryable: false,
    })
    await expect(
      raiseForStatus(Response.json({ error: { message: "project access denied" } }, { status: 403 })),
    ).rejects.toMatchObject({ message: "project access denied", retryable: false })
    await expect(raiseForStatus(new Response("", { status: 403 }))).rejects.toMatchObject({
      message: "OpenAI denied the request; confirm the API key has access to this project",
      retryable: false,
    })
  })
})
