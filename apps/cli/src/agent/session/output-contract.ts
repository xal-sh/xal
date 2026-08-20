import Ajv, { type SchemaObject, type ValidateFunction } from "ajv"
import addFormats from "ajv-formats"
import { isJsonObject, type JsonObject } from "../../lib/json"
import type { RegisteredTool, ToolResult } from "../../tools/types"

const MAX_ATTEMPTS = 3

export type OutputSchema = SchemaObject & JsonObject

export function parseOutputSchema(value: unknown): OutputSchema {
  if (!isJsonObject(value)) throw new Error("output schema must be a JSON object")
  if (value.type !== "object") throw new Error('output schema must have top-level type "object"')
  if (value.$async === true) throw new Error("asynchronous output schemas are not supported")
  return value
}

export class OutputContract {
  readonly tool: RegisteredTool
  private attempts = 0
  private submitted: JsonObject | undefined

  constructor(schema: OutputSchema) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile<JsonObject>(schema)

    this.tool = {
      name: "submit_output",
      description:
        "Submit the final response exactly once as an object matching the caller-provided JSON Schema. Text responses do not satisfy this output contract; correct and resubmit values rejected by the schema.",
      parameters: schema,
      title: () => "Submit structured output",
      readOnly: () => true,
      concurrency: () => "exclusive",
      execute: async (args: Record<string, unknown>) => this.submit(args, validate, ajv),
    }
  }

  get output(): JsonObject | undefined {
    return this.submitted
  }

  get exhausted(): boolean {
    return this.attempts >= MAX_ATTEMPTS
  }

  reset(): void {
    this.attempts = 0
    this.submitted = undefined
  }

  missing(): string {
    return this.reject("The previous response did not call submit_output.")
  }

  failure(): Error {
    return new Error(`model did not produce valid structured output after ${MAX_ATTEMPTS} attempts`)
  }

  private submit(args: Record<string, unknown>, validate: ValidateFunction<JsonObject>, ajv: Ajv): ToolResult {
    if (this.submitted) return { output: "Structured output was already accepted." }
    if (!isJsonObject(args) || !validate(args)) {
      const detail = isJsonObject(args) ? ajv.errorsText(validate.errors, { separator: "; " }) : "value is not JSON"
      return { output: this.reject(`Structured output rejected: ${detail}.`) }
    }
    this.submitted = args
    return { output: "Structured output accepted." }
  }

  private reject(message: string): string {
    this.attempts += 1
    const remaining = MAX_ATTEMPTS - this.attempts
    if (remaining === 0) return `${message} No attempts remain.`
    return `${message} Correct the final value and retry; ${remaining} ${remaining === 1 ? "attempt remains" : "attempts remain"}.`
  }
}
