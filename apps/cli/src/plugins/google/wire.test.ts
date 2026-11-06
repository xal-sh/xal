import { describe, expect, test } from "bun:test"
import type { ConversationItem, StreamRequest } from "../../providers/types"
import { buildRequestBody } from "./transport"
import { buildContents, parseChunk } from "./wire"

const target = { provider: "google", model: "gemini-3.1-pro-preview" }

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    instructions: "be helpful",
    tools: [],
    cacheKey: "key",
    model: "gemini-3.1-pro-preview",
    input: [{ type: "user_message", text: "hi", images: [] }],
    toolChoice: "auto",
    sessionId: "session",
    ...overrides,
  }
}

describe("thinking configuration", () => {
  test("Gemini 3 Pro only ever receives the two levels it accepts", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const body = buildRequestBody(request({ thinking: effort }))
      const config = (body.generationConfig as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig
      expect(["LOW", "HIGH"]).toContain(config.thinkingLevel)
    }
  })

  test("Gemini 3 Pro cannot disable thinking, so none asks for the lowest level", () => {
    const body = buildRequestBody(request({ thinking: "none" }))
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } })
  })

  test("Gemini 3 Flash accepts the minimal level when thinking is off", () => {
    const body = buildRequestBody(request({ model: "gemini-3.6-flash", thinking: "none" }))
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } })
  })

  test("Gemini 2.x uses a token budget rather than a level", () => {
    const off = buildRequestBody(request({ model: "gemini-2.5-flash", thinking: "none" }))
    expect(off.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } })
    const on = buildRequestBody(request({ model: "gemini-2.5-flash", thinking: "high" }))
    expect(on.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 16_384, includeThoughts: true } })
  })

  test("reserves answer space within auxiliary output limits", () => {
    expect(
      buildRequestBody(request({ model: "gemini-2.5-flash", thinking: "high", maxOutputTokens: 2000 }))
        .generationConfig,
    ).toEqual({
      maxOutputTokens: 2000,
      thinkingConfig: { thinkingBudget: 976, includeThoughts: true },
    })
  })

  test.each([129, 1024, 1100])("keeps mandatory Pro thinking valid under a %s-token ceiling", (maximum) => {
    expect(
      buildRequestBody(request({ model: "gemini-2.5-pro", thinking: "low", maxOutputTokens: maximum }))
        .generationConfig,
    ).toEqual({ maxOutputTokens: maximum, thinkingConfig: { thinkingBudget: 128, includeThoughts: true } })
  })

  test("rejects a ceiling that cannot fit mandatory thinking and disables subminimum Flash-Lite thinking", () => {
    expect(() => buildRequestBody(request({ model: "gemini-2.5-pro", maxOutputTokens: 128 }))).toThrow(
      "mandatory thinking and an answer",
    )
    expect(
      buildRequestBody(request({ model: "gemini-2.5-pro", thinking: "none", maxOutputTokens: 2000 })).generationConfig,
    ).toEqual({ maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 128, includeThoughts: false } })
    expect(
      buildRequestBody(request({ model: "gemini-2.5-flash-lite", maxOutputTokens: 1535 })).generationConfig,
    ).toEqual({ maxOutputTokens: 1535, thinkingConfig: { thinkingBudget: 0 } })
    expect(
      buildRequestBody(request({ model: "gemini-2.5-flash-lite", maxOutputTokens: 1536 })).generationConfig,
    ).toEqual({ maxOutputTokens: 1536, thinkingConfig: { thinkingBudget: 512, includeThoughts: true } })
  })

  test("system instructions are sent separately from contents", () => {
    const body = buildRequestBody(request())
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be helpful" }] })
  })
})

describe("buildContents", () => {
  test("answers a tool result with the originating function name", () => {
    const items: ConversationItem[] = [
      { type: "tool_call", callId: "call-1", name: "read_file", args: { path: "a.ts" } },
      { type: "tool_result", callId: "call-1", output: "contents" },
    ]
    expect(buildContents(items, target)).toEqual([
      { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "contents" } } }] },
    ])
  })

  test("echoes the provider call id back on the function response", () => {
    const part = { functionCall: { id: "call_abc", name: "read_file", args: {} } }
    const items: ConversationItem[] = [
      {
        type: "tool_call",
        callId: "call_abc",
        name: "read_file",
        args: {},
        replay: { provider: "google", model: target.model, data: part },
      },
      { type: "tool_result", callId: "call_abc", output: "contents" },
    ]
    expect(buildContents(items, target)).toEqual([
      { role: "model", parts: [part] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read_file", response: { output: "contents" }, id: "call_abc" } }],
      },
    ])
  })

  test("replays thought signatures back to the same model", () => {
    const part = { text: "reasoning", thought: true, thoughtSignature: "sig" }
    const items: ConversationItem[] = [
      { type: "reasoning", summary: "reasoning", replay: { provider: "google", model: target.model, data: part } },
      { type: "assistant_message", text: "answer" },
    ]
    expect(buildContents(items, target)).toEqual([{ role: "model", parts: [part, { text: "answer" }] }])
  })

  test("drops thought signatures that belong to a different model", () => {
    const items: ConversationItem[] = [
      {
        type: "reasoning",
        summary: "reasoning",
        replay: { provider: "google", model: "gemini-3.5-flash", data: { text: "x", thought: true } },
      },
      { type: "assistant_message", text: "answer" },
    ]
    expect(buildContents(items, target)).toEqual([{ role: "model", parts: [{ text: "answer" }] }])
  })

  test("sends images as inline data", () => {
    const items: ConversationItem[] = [
      { type: "user_message", text: "look", images: [{ mediaType: "image/jpeg", data: "BBB" }] },
    ]
    expect(buildContents(items, target)).toEqual([
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "image/jpeg", data: "BBB" } }, { text: "look" }],
      },
    ])
  })
})

describe("parseChunk", () => {
  test("separates thoughts from answer text", () => {
    const chunk = parseChunk({
      candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer" }] } }],
    })
    expect(chunk?.parts.map((part) => part.kind)).toEqual(["thought", "text"])
  })

  test("synthesized call ids stay unique across requests", () => {
    const chunk = () =>
      parseChunk({ candidates: [{ content: { parts: [{ functionCall: { name: "grep", args: {} } }] } }] })
    const first = chunk()?.parts[0] as { callId: string }
    const second = chunk()?.parts[0] as { callId: string }
    expect(first.callId).not.toBe(second.callId)
  })

  test("keeps a provider-supplied call id", () => {
    const chunk = parseChunk({
      candidates: [{ content: { parts: [{ functionCall: { id: "call_abc", name: "grep", args: {} } }] } }],
    })
    expect(chunk?.parts[0]).toMatchObject({ callId: "call_abc" })
  })

  test("counts thought tokens as output", () => {
    const chunk = parseChunk({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    })
    expect(chunk?.usage).toEqual({ totalInputTokens: 100, cacheReadInputTokens: undefined, outputTokens: 50 })
  })

  test("classifies unavailable errors as retryable", () => {
    const chunk = parseChunk({ error: { status: "UNAVAILABLE", message: "backend down" } })
    expect(chunk?.failure).toEqual({ message: "backend down", retryable: true })
  })
})
