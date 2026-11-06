import { describe, expect, test } from "bun:test"
import { argumentErrors } from "./arguments"

const readSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    offset: { type: "number" },
    mode: { type: "string", enum: ["content", "files"] },
  },
  required: ["file_path"],
  additionalProperties: false,
}

describe("argumentErrors", () => {
  test("accepts arguments that match the schema and treats null optional arguments as omitted", () => {
    expect(argumentErrors(readSchema, { file_path: "a.ts", offset: 3, mode: "files" })).toEqual([])
    expect(argumentErrors(readSchema, { file_path: "a.ts", offset: null })).toEqual([])
  })

  test("names wrong types, missing and unknown arguments, and enum mismatches", () => {
    expect(argumentErrors(readSchema, { path: "a.ts", offset: "3", mode: "lines" })).toEqual([
      "missing required argument file_path",
      "unknown argument path; expected file_path, offset, mode",
      "offset must be number, got string",
      'mode must be one of "content", "files"',
    ])
    expect(argumentErrors(readSchema, { file_path: null })).toEqual(["file_path must be string, got null"])
  })

  test("checks nested arrays and objects", () => {
    const schema = {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, count: { type: "integer" } },
            required: ["id"],
          },
        },
      },
    }
    expect(argumentErrors(schema, { questions: [{ id: "a", count: 1 }, { count: 1.5 }] })).toEqual([
      "missing required argument questions[1].id",
      "questions[1].count must be integer, got number",
    ])
  })

  test("leaves constructs it does not understand to the tool", () => {
    expect(argumentErrors({ type: "object", properties: { value: { $ref: "#/$defs/x" } } }, { value: 1 })).toEqual([])
    expect(argumentErrors({ type: "object", properties: { value: { type: "custom" } } }, { value: 1 })).toEqual([])
    expect(argumentErrors({ anyOf: [{ type: "string" }, { type: "number" }] }, 1)).toEqual([])
    expect(argumentErrors({ anyOf: [{ type: "string" }, { type: "number" }] }, true)).toEqual([
      "arguments does not match any of its allowed forms",
    ])
  })
})
