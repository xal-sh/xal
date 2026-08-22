import { describe, expect, test } from "bun:test"
import {
  parseDiff,
  parseGitCommandOutput,
  parseGitRepository,
  parseManagedWorktree,
  parseNativeProcess,
  parseNativeShellManager,
  parsePathRanker,
  parseSearchOutcome,
  parseToolOutput,
  parseWorkspaceIndex,
  parseWorktreeResult,
  parseWorktreeToolPreparation,
} from "./contracts"

describe("native contract parsing", () => {
  test("accepts completed search output and preserves native outcomes", () => {
    expect(parseSearchOutcome({ kind: "completed", total: 1, lines: ["one"], output: "Found 1 file\none" })).toEqual({
      output: "Found 1 file\none",
    })
    expect(parseSearchOutcome({ kind: "interrupted", total: 0, lines: [] })).toEqual({
      output: "(interrupted by user)",
    })
    expect(() => parseSearchOutcome({ kind: "timedOut", total: 0, lines: [] })).toThrow("Search timed out after 30s")
    expect(() =>
      parseSearchOutcome({ kind: "invalidRequest", total: 0, lines: [], error: { message: "invalid pattern" } }),
    ).toThrow("invalid pattern")
    expect(() =>
      parseSearchOutcome({ kind: "failed", total: 0, lines: [], error: { message: "read failed" } }),
    ).toThrow("read failed")
  })

  test("rejects malformed search outcomes", () => {
    for (const value of [
      null,
      { kind: "completed", total: -1, lines: [], output: "none" },
      { kind: "completed", total: 0, lines: [1], output: "none" },
      { kind: "completed", total: 0, lines: [] },
      { kind: "interrupted" },
      { kind: "failed", total: 0, lines: [], error: "failed" },
      { kind: "unknown", total: 0, lines: [] },
    ]) {
      expect(() => parseSearchOutcome(value)).toThrow("native search returned an invalid value")
    }
  })

  test("rejects malformed file, Git, and diff outcomes", () => {
    expect(() => parseToolOutput({}, "native read returned an invalid value")).toThrow(
      "native read returned an invalid value",
    )
    expect(() => parseGitCommandOutput({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })).toThrow(
      "native git returned an invalid value",
    )
    expect(() => parseDiff({ hunks: "", added: Number.MAX_SAFE_INTEGER + 1, removed: 0 })).toThrow(
      "native diff returned an invalid value",
    )
  })

  test("rejects contradictory native Git, worktree, and process values", async () => {
    expect(() =>
      parseManagedWorktree({
        version: 1,
        repositoryRoot: "relative",
        originalCwd: "/tmp/original",
        path: "/tmp/worktree",
        cwd: "/tmp/worktree",
        branch: "branch",
        baseCommit: "commit",
      }),
    ).toThrow("native worktree returned an invalid value")
    expect(() => parseWorktreeResult({ found: false, worktree: {} })).toThrow(
      "native worktree returned an invalid value",
    )
    expect(() => parseWorktreeToolPreparation({ operation: "enter", name: "name", force: true })).toThrow(
      "native worktree tool returned an invalid value",
    )

    const repository = parseGitRepository({
      run: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0, interrupted: false }),
      discover: async () => ({ kind: "discovery", ready: true, root: "relative" }),
      capture: async () => ({ kind: "tree", tree: "tree" }),
      changedPaths: async () => ({ kind: "paths", paths: [] }),
      indexState: async () => ({ kind: "bytes", bytes: new Uint8Array() }),
      headState: async () => ({ kind: "text", text: "" }),
      gitlinks: async () => ({ kind: "gitlinks", gitlinks: [] }),
      applySnapshot: async () => ({ kind: "applied" }),
    })
    await expect(repository.discover()).rejects.toThrow("native git repository returned an invalid value")

    const process = parseNativeProcess({
      write() {},
      closeStdin() {},
      resize() {},
      drain: () => new Uint8Array(),
      outputClosed: () => true,
      wait: async () => ({ status: "signaled", exitCode: 0 }),
      setTimeout() {},
      clearTimeout() {},
      timedOut: () => false,
      terminate() {},
      kill() {},
    })
    await expect(process.wait()).rejects.toThrow("native process returned an invalid termination")

    expect(() => parseNativeShellManager({ execute() {}, disposeSession() {} })).toThrow(
      "native shell manager is invalid",
    )
  })

  test("validates stateful native class methods and results", async () => {
    expect(() => parsePathRanker({})).toThrow("native path ranker is invalid")
    const ranker = parsePathRanker({ rank: () => [1] })
    expect(() => ranker.rank("query", 1)).toThrow("native path ranking returned an invalid value")

    const index = parseWorkspaceIndex({ search: () => ({ kind: "completed", paths: [1] }) })
    await expect(index.search("query")).rejects.toThrow("native workspace search returned an invalid value")
  })
})
