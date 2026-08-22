import { describe, expect, test } from "bun:test"
import {
  disposeInteractiveSessions,
  dropInteractiveSession,
  interactiveSession,
  startInteractiveSession,
} from "./session"

describe("interactive session", () => {
  test("returns completed PTY output", async () => {
    const session = startInteractiveSession("printf hello", process.cwd(), process.cwd(), undefined, "test")
    const termination = await session.done
    expect(termination).toEqual({ status: "exited", exitCode: 0 })
    expect(interactiveSession(session.id, "test")).toBe(session)
    expect(session.drain().trimEnd()).toBe("hello")
    dropInteractiveSession(session.id)
  })

  test("forwards input to a PTY", async () => {
    const session = startInteractiveSession(
      "read line; echo got:$line",
      process.cwd(),
      process.cwd(),
      undefined,
      "test",
    )
    session.write("hi\n")
    const termination = await session.done
    expect(termination).toEqual({ status: "exited", exitCode: 0 })
    expect(session.drain()).toContain("got:hi")
    dropInteractiveSession(session.id)
  })

  test("drains only output that appeared after the previous drain", async () => {
    const session = startInteractiveSession(
      "printf one; sleep 0.2; printf two",
      process.cwd(),
      process.cwd(),
      undefined,
      "test",
    )
    await Bun.sleep(50)
    const first = session.drain()
    expect(first).toContain("one")
    expect(first).not.toContain("two")
    await session.done
    const second = session.drain()
    expect(second).toContain("two")
    expect(second).not.toContain("one")
    dropInteractiveSession(session.id)
  })

  test("returns only new output after the buffer truncates", async () => {
    const script =
      'process.stdout.write("a".repeat(270000) + "READY"); await Bun.sleep(400); process.stdout.write("ZZZ")'
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    const session = startInteractiveSession(command, process.cwd(), process.cwd(), undefined, "test")
    let first = ""
    for (let attempt = 0; attempt < 50 && !first.includes("READY"); attempt++) {
      await Bun.sleep(20)
      first += session.drain()
    }
    expect(first).toContain("READY")
    await session.done
    expect(session.drain()).toBe("ZZZ")
    dropInteractiveSession(session.id)
  })

  test("resizes the active terminal", async () => {
    const session = startInteractiveSession("read line; stty size", process.cwd(), process.cwd(), undefined, "test")
    session.resize(91, 31)
    session.write("\n")
    await session.done
    expect(session.drain()).toContain("31 91")
    dropInteractiveSession(session.id)
  })

  test("scopes session lookup and disposal to the owner", () => {
    const first = startInteractiveSession("sleep 5", process.cwd(), process.cwd(), undefined, "owner-a")
    const second = startInteractiveSession("sleep 5", process.cwd(), process.cwd(), undefined, "owner-b")
    expect(interactiveSession(first.id, "owner-a")).toBe(first)
    expect(interactiveSession(first.id, "owner-b")).toBeUndefined()
    disposeInteractiveSessions("owner-a")
    expect(interactiveSession(first.id, "owner-a")).toBeUndefined()
    expect(interactiveSession(second.id, "owner-b")).toBe(second)
    second.kill()
    dropInteractiveSession(second.id)
  })
})
