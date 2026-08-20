import { isJsonObject, type JsonObject } from "../../lib/json"
import { createNativeOutputContract, type NativeOutputContract } from "../../native"
import type { RegisteredTool } from "../../tools/types"

export type OutputSchema = JsonObject

export function parseOutputSchema(value: unknown): OutputSchema {
  if (!isJsonObject(value)) throw new Error("output schema must be a JSON object")
  createNativeOutputContract(value)
  return value
}

export class OutputContract {
  readonly tool: RegisteredTool
  private readonly native: NativeOutputContract

  constructor(schema: OutputSchema) {
    this.native = createNativeOutputContract(schema)
    this.tool = {
      name: "submit_output",
      description:
        "Submit the final response exactly once as an object matching the caller-provided JSON Schema. Text responses do not satisfy this output contract; correct and resubmit values rejected by the schema.",
      parameters: schema,
      title: () => "Submit structured output",
      readOnly: () => true,
      concurrency: () => "exclusive",
      execute: async (args: Record<string, unknown>) => ({
        output: this.native.submit(isJsonObject(args) ? JSON.stringify(args) : undefined),
      }),
    }
  }

  get output(): JsonObject | undefined {
    const output = this.native.output
    if (output === undefined) return undefined
    const value: unknown = JSON.parse(output)
    if (!isJsonObject(value)) throw new Error("native output contract returned an invalid value")
    return value
  }

  get exhausted(): boolean {
    return this.native.exhausted
  }

  reset(): void {
    this.native.reset()
  }

  missing(): string {
    return this.native.missing()
  }

  failure(): Error {
    return new Error(this.native.failure())
  }
}
