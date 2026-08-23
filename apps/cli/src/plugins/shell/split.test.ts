import { describe, expect, test } from "bun:test"
import { splitCommand } from "./split"

describe("splitCommand", () => {
  test("splits every supported command separator", () => {
    for (const example of [
      { command: "git status && bun test", segments: ["git status", "bun test"] },
      { command: "bun test || bun run lint", segments: ["bun test", "bun run lint"] },
      { command: "printf ready | wc -c", segments: ["printf ready", "wc -c"] },
      { command: "bun test; bun run lint", segments: ["bun test", "bun run lint"] },
      { command: "bun test\nbun run lint", segments: ["bun test", "bun run lint"] },
    ]) {
      expect(splitCommand(example.command)).toEqual(example.segments)
    }
  })

  test("keeps quoted and escaped separators within their command", () => {
    expect(splitCommand("printf '%s' 'left && right | still; one\ntwo' && next")).toEqual([
      "printf '%s' 'left && right | still; one\ntwo'",
      "next",
    ])
    expect(splitCommand('printf "%s" "left && right | still; one" | next')).toEqual([
      'printf "%s" "left && right | still; one"',
      "next",
    ])
    expect(splitCommand("echo left \\| right \\; still \\&\\& one")).toEqual([
      "echo left \\| right \\; still \\&\\& one",
    ])
    expect(splitCommand("echo 'left > right'")).toEqual(["echo 'left > right'"])
  })

  test("keeps redirections within their command instead of splitting on them", () => {
    expect(splitCommand("sort < input | uniq > output")).toEqual(["sort < input", "uniq > output"])
    expect(splitCommand("command 2>> errors 2>&1 &> all")).toEqual(["command 2>> errors 2>&1 &> all"])
  })

  test("rejects shell constructs that cannot be split safely", () => {
    for (const command of [
      "echo $(date)",
      'echo "$(date)"',
      "echo `date`",
      "(echo grouped)",
      "{ echo grouped; }",
      "echo first & echo second",
      "echo 'unterminated",
    ]) {
      expect(splitCommand(command)).toBeUndefined()
    }
  })

  test("rejects input without a command", () => {
    for (const command of ["", "   ", "&& || ; |\n"]) {
      expect(splitCommand(command)).toBeUndefined()
    }
  })
})
