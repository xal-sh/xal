import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../events"
import { createAgentEventMulticast } from "./spawn"

const event: AgentEvent = { type: "text_delta", text: "hi" }

describe("task agent event multicast", () => {
  test("delivers each event to every subscribed listener until it unsubscribes", () => {
    const multicast = createAgentEventMulticast()
    const first: AgentEvent[] = []
    const second: AgentEvent[] = []
    const offFirst = multicast.onEvent((event) => first.push(event))
    multicast.onEvent((event) => second.push(event))

    multicast.emit(event)
    expect(first).toEqual([event])
    expect(second).toEqual([event])

    offFirst()
    multicast.emit(event)
    expect(first).toEqual([event])
    expect(second).toEqual([event, event])
  })

  test("a throwing listener does not block the others", () => {
    const multicast = createAgentEventMulticast()
    const delivered: AgentEvent[] = []
    multicast.onEvent(() => {
      throw new Error("boom")
    })
    multicast.onEvent((event) => delivered.push(event))

    multicast.emit(event)
    expect(delivered).toEqual([event])
  })
})
