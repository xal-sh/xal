import { describe, expect, test } from "bun:test"
import { isInteractiveTool, isSessionTool, type ToolResult } from "../tools/types"
import { OutputContract, parseOutputSchema } from "./output-contract"

async function execute(contract: OutputContract, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = contract.tool
  if (isInteractiveTool(tool) || isSessionTool(tool)) throw new Error("submit_output has an unexpected tool kind")
  return tool.execute(args, {
    cwd: process.cwd(),
    sessionId: "output-contract-test",
    sessionKind: "primary",
    directory: process.cwd(),
    signal: new AbortController().signal,
    update() {},
  })
}

describe("parseOutputSchema", () => {
  test("rejects values that cannot define a synchronous object contract", () => {
    const cases: { value: unknown; message: string }[] = [
      { value: null, message: "output schema must be a JSON object" },
      { value: [], message: "output schema must be a JSON object" },
      { value: "object", message: "output schema must be a JSON object" },
      { value: {}, message: 'output schema must have top-level type "object"' },
      { value: { type: "array" }, message: 'output schema must have top-level type "object"' },
      {
        value: { type: "object", $async: true },
        message: "asynchronous output schemas are not supported",
      },
    ]

    for (const entry of cases) {
      expect(() => parseOutputSchema(entry.value)).toThrow(entry.message)
    }
  })
})

describe("OutputContract", () => {
  test("counts missing and invalid submissions through attempt exhaustion", async () => {
    const contract = new OutputContract({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    })

    expect(contract.exhausted).toBe(false)
    expect(contract.missing()).toBe(
      "The previous response did not call submit_output. Correct the final value and retry; 2 attempts remain.",
    )

    const nonJson = await execute(contract, { count: undefined })
    expect(nonJson.output).toBe(
      "Structured output rejected: value is not JSON. Correct the final value and retry; 1 attempt remains.",
    )

    const invalid = await execute(contract, { count: "three" })
    expect(invalid.output).toStartWith("Structured output rejected:")
    expect(invalid.output).toEndWith("No attempts remain.")
    expect(contract.exhausted).toBe(true)
    expect(contract.failure().message).toBe("model did not produce valid structured output after 3 attempts")

    contract.reset()

    expect(contract.exhausted).toBe(false)
    expect(contract.missing()).toEndWith("2 attempts remain.")
  })

  test("validates nested values and standard string formats", async () => {
    const contract = new OutputContract({
      type: "object",
      properties: {
        contact: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            tags: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["email", "tags"],
          additionalProperties: false,
        },
        generatedAt: { type: "string", format: "date-time" },
      },
      required: ["contact", "generatedAt"],
      additionalProperties: false,
    })

    const invalid = await execute(contract, {
      contact: { email: "not-an-email", tags: ["primary"], unexpected: true },
      generatedAt: "yesterday",
    })
    expect(invalid.output).toContain('must match format "email"')
    expect(invalid.output).toContain('must match format "date-time"')
    expect(invalid.output).toContain("must NOT have additional properties")

    const output = {
      contact: { email: "person@example.com", tags: ["primary"] },
      generatedAt: "2026-08-12T12:00:00Z",
    }
    expect(await execute(contract, output)).toEqual({ output: "Structured output accepted." })
    expect(contract.output).toEqual(output)
  })

  test("keeps accepted output immutable until reset", async () => {
    const contract = new OutputContract({
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    })

    expect(await execute(contract, { id: 1 })).toEqual({ output: "Structured output accepted." })
    expect(await execute(contract, { id: 2 })).toEqual({ output: "Structured output was already accepted." })
    expect(contract.output).toEqual({ id: 1 })

    contract.reset()

    expect(contract.output).toBeUndefined()
    expect(contract.exhausted).toBe(false)
    expect(await execute(contract, { id: 2 })).toEqual({ output: "Structured output accepted." })
    expect(contract.output).toEqual({ id: 2 })
  })
})
