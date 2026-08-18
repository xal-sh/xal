import { describe, expect, test } from "bun:test"
import { ImeCommitBarrier, isImeCommit } from "./composer"

function waitForBarrier(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe("ImeCommitBarrier", () => {
  test.each(["한", "日", "你", "é", "क"])("commits %s before the boundary action", async (commit) => {
    const barrier = new ImeCommitBarrier()
    const events: string[] = []

    expect(isImeCommit({ sequence: commit, ctrl: false, meta: false })).toBe(true)
    barrier.enqueue(() => events.push(" "))
    setTimeout(() => events.push(commit), 0)
    await waitForBarrier()

    expect(events.join("")).toBe(`${commit} `)
  })

  test("does not treat ordinary or modified input as an IME commit", () => {
    expect(isImeCommit({ sequence: "b", ctrl: false, meta: false })).toBe(false)
    expect(isImeCommit({ sequence: "한", ctrl: true, meta: false })).toBe(false)
    expect(isImeCommit({ sequence: "한", ctrl: false, meta: true })).toBe(false)
  })

  test("preserves boundary action order", async () => {
    const barrier = new ImeCommitBarrier()
    const events: string[] = []

    barrier.enqueue(() => events.push("space"))
    barrier.enqueue(() => events.push("newline"))
    barrier.enqueue(() => events.push("submit"))
    barrier.enqueue(() => events.push("next-input"))
    setTimeout(() => events.push("commit"), 0)
    await waitForBarrier()

    expect(events).toEqual(["commit", "space", "newline", "submit", "next-input"])
  })

  test("clears pending actions", async () => {
    const barrier = new ImeCommitBarrier()
    let called = false

    barrier.enqueue(() => {
      called = true
    })
    barrier.clear()
    await waitForBarrier()

    expect(called).toBe(false)
  })
})
