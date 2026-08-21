import { describe, expect, test } from "bun:test"
import { parseAppOptions } from "./app-options"

describe("parseAppOptions", () => {
  test("uses normal startup defaults", () => {
    expect(parseAppOptions([])).toEqual({ profile: false, mode: undefined, args: [] })
  })

  test("parses a startup mode with profiling", () => {
    expect(parseAppOptions(["--mode", "plan", "--profile"])).toEqual({
      profile: true,
      mode: "plan",
      args: [],
    })
  })

  test("leaves command options for the command parser", () => {
    expect(parseAppOptions(["run", "--mode", "yolo", "hello"])).toEqual({
      profile: false,
      mode: undefined,
      args: ["run", "--mode", "yolo", "hello"],
    })
  })

  test("requires a mode value", () => {
    expect(() => parseAppOptions(["--mode"])).toThrow("--mode expects a value")
  })

  test("rejects duplicate modes", () => {
    expect(() => parseAppOptions(["--mode", "normal", "--mode", "yolo"])).toThrow("duplicate option: --mode")
  })
})
