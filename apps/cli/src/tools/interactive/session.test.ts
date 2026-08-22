import { describe, expect, test } from "bun:test"
import { dropInteractiveSession, startInteractiveSession } from "./session"

describe("interactive session", () => {
  test("returns completed PTY output", async () => {
    const session = startInteractiveSession("printf hello", process.cwd(), undefined, "test")
    const termination = await session.done
    expect(termination.status).toBe("exited")
    expect(termination.exitCode).toBe(0)
    expect(session.drain().trimEnd()).toBe("hello")
    dropInteractiveSession(session.id)
  })

  test("forwards input to a PTY", async () => {
    const session = startInteractiveSession("read line; echo got:$line", process.cwd(), undefined, "test")
    session.write("hi\n")
    const termination = await session.done
    expect(termination.status).toBe("exited")
    expect(termination.exitCode).toBe(0)
    expect(session.drain()).toContain("got:hi")
    dropInteractiveSession(session.id)
  })
})
