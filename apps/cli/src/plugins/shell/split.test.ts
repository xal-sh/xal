import { describe, expect, test } from "bun:test"
import { commandPrefix, splitCommand } from "./split"

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

describe("commandPrefix", () => {
  test("extracts the first command segment", () => {
    expect(commandPrefix("pnpm test")).toEqual({ prefix: "pnpm test", rest: "" })
    expect(commandPrefix("pnpm test && pnpm lint")).toEqual({ prefix: "pnpm test", rest: "pnpm lint" })
    expect(commandPrefix("git status && git diff")).toEqual({ prefix: "git status", rest: "git diff" })
    expect(commandPrefix("npm run build && npm test")).toEqual({ prefix: "npm run build", rest: "npm test" })
  })

  test("returns undefined when the first segment cannot be parsed safely", () => {
    for (const command of ["echo $(date) && echo done", "echo 'unterminated"]) {
      expect(commandPrefix(command)).toBeUndefined()
    }
  })

  test("rejects a first segment that is only a command assignment", () => {
    expect(commandPrefix("FOO=1 && echo done")).toBeUndefined()
  })

  test("rejects a leading environment-assignment prefix", () => {
    expect(commandPrefix("FOO=1 pnpm test && pnpm lint")).toBeUndefined()
    expect(commandPrefix("A_B=2 npm run build && git status")).toBeUndefined()
    expect(commandPrefix("FOO+=1 pnpm test && pnpm lint")).toBeUndefined()
  })

  test("rejects a first segment that is a control-group body", () => {
    expect(commandPrefix("{ echo grouped; } && echo done")).toBeUndefined()
  })

  test("rejects shell control-form prefixes", () => {
    for (const command of [
      "if true; then rm -rf /; fi",
      "while true; do echo hi; done",
      "for f in x; do echo $f; done",
      "case x in x) rm -rf /;; esac",
      "! grep foo && echo done",
    ]) {
      expect(commandPrefix(command)).toBeUndefined()
    }
  })
})
