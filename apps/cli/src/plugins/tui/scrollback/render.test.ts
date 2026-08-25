import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { displayWidth, terminalGlyph } from "../lib/text"
import type { BackgroundBlock } from "./blocks"
import { backgroundResultHeading } from "./render"
import { Scrollback } from "./scrollback"

const completed: BackgroundBlock = {
  kind: "background",
  id: "sleeper2",
  label: 'Wait for 3 seconds, then report: "sleeper 2 is back". Do not inspect or modify files.',
  status: "completed",
  output: "sleeper 2 is back\nFull task record: /tmp/sleeper2.md",
}

test("background results use the first report line in normal mode", () => {
  expect(backgroundResultHeading(completed, false, "Ctrl+O", 100)).toBe(
    `${terminalGlyph("↳", ">")} sleeper2 · sleeper 2 is back · Ctrl+O to read it`,
  )
})

test("background results move assignment metadata into expanded mode", () => {
  const heading = backgroundResultHeading(completed, true, "Ctrl+O", 100)

  expect(heading).toContain(completed.label)
  expect(heading).toContain("completed · 2 lines")
  expect(heading).not.toContain("Ctrl+O")
})

test("normal background results keep failures visible and stay on one row", () => {
  const failed: BackgroundBlock = { ...completed, status: "failed", output: "connection lost while waiting" }
  const heading = backgroundResultHeading(failed, false, "Ctrl+O", 48)
  const narrow = backgroundResultHeading(failed, false, "Ctrl+O", 30)
  const longId = backgroundResultHeading({ ...failed, id: "agent-with-a-very-long-identifier" }, false, "Ctrl+O", 48)

  expect(heading).toContain("sleeper2 · failed")
  expect(heading).toContain("Ctrl+O to read it")
  expect(narrow).toContain("sleeper2 · failed")
  expect(longId).toEndWith(" · failed")
  expect([heading, narrow, longId].every((value) => displayWidth(value) <= 48)).toBe(true)
  expect(displayWidth(narrow)).toBeLessThanOrEqual(30)
})

test("user bubbles preserve composer line breaks", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    scrollback.append({ kind: "user", text: "first line\n\n$implement second line", imageCount: 0, sentAt: 0 })

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows[2]).toStartWith("   first line")
    expect(rows[3]).toBe("")
    expect(rows[4]?.trim()).toBe("$implement second line")
  } finally {
    setup.renderer.destroy()
  }
})

test("compaction state is visible in the transcript as soon as it starts", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    scrollback.append({ kind: "compaction", state: "compacting" })

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows).toEqual(["", "  Compacting context..."])
  } finally {
    setup.renderer.destroy()
  }
})

test("settled tools leave the scrollback cursor on their row for live tool grouping", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    scrollback.append({
      kind: "tool",
      tool: "wait_agent",
      title: "Wait for task-agent activity",
      readOnly: true,
      denial: undefined,
      output: "wait ended",
      execution: undefined,
      elapsed: "20s",
      expanded: false,
    })

    const commits = setup.externalOutput.take()
    expect(commits.at(-1)?.trailingNewline).toBe(false)
  } finally {
    setup.renderer.destroy()
  }
})

test("viewport replay re-prints only the last two viewports of blocks", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 10,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    await setup.renderer.setupTerminal()
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    for (let index = 0; index < 30; index += 1) {
      scrollback.append({ kind: "info", text: `entry ${index}` })
    }
    setup.externalOutput.clear()

    scrollback.replayViewport()

    const commits = setup.externalOutput.take()
    const rows = commits.flatMap((commit) => commit.rows)
    const entries = rows.filter((row) => row.includes("entry"))
    expect(commits.length).toBe(1)
    expect(rows.length).toBeGreaterThanOrEqual(20)
    expect(rows.length).toBeLessThan(30)
    expect(entries[0]).toContain("entry 20")
    expect(entries.at(-1)).toContain("entry 29")
  } finally {
    setup.renderer.destroy()
  }
})

test("session replay defers emission and lands as one viewport batch", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 10,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    scrollback.beginReplay()
    scrollback.clear()
    for (let index = 0; index < 30; index += 1) {
      scrollback.append({ kind: "info", text: `entry ${index}` })
    }
    expect(setup.externalOutput.take()).toEqual([])

    scrollback.endReplay()

    const commits = setup.externalOutput.take()
    const entries = commits.flatMap((commit) => commit.rows).filter((row) => row.includes("entry"))
    expect(commits.length).toBe(1)
    expect(entries[0]).toContain("entry 20")
    expect(entries.at(-1)).toContain("entry 29")
  } finally {
    setup.renderer.destroy()
  }
})

test("assistant markdown commits only its visible columns", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  try {
    const scrollback = new Scrollback(
      setup.renderer,
      0,
      () => {},
      { showOutputs: false, showThinking: false },
      undefined,
    )
    scrollback.appendStream(
      "text",
      "```sh\n./benchmark.sh \\\n    --attempts 5 \\\n    --model gpt-5.6-luna \\\n    --job-name xal-gpt-5.6-luna-xhigh-k5\n```",
    )
    scrollback.endStream()

    const commits = setup.externalOutput.take()
    const rows = commits.flatMap((commit) => commit.rows)
    expect(rows).toEqual([
      "",
      "  ./benchmark.sh \\",
      "      --attempts 5 \\",
      "      --model gpt-5.6-luna \\",
      "      --job-name xal-gpt-5.6-luna-xhigh-k5",
    ])
    expect(commits.every((commit) => commit.height === 1)).toBe(true)
    expect(commits.map((commit) => commit.rowColumns)).toEqual(rows.map(displayWidth))
    expect(commits.map((commit) => commit.trailingNewline)).toEqual([true, true, true, true, false])
  } finally {
    setup.renderer.destroy()
  }
})
