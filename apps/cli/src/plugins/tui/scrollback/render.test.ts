import { expect, test } from "bun:test"
import { t } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { appInfo } from "../../../app-info"
import { registerLiveToolRenderer, registerToolRenderer } from "../../../ui/extension"
import { displayWidth, terminalGlyph } from "../lib/text"
import type { BackgroundBlock, ToolBlock } from "./blocks"
import { backgroundResultHeading } from "./render"
import { Scrollback } from "./scrollback"

const completed: BackgroundBlock = {
  kind: "background",
  id: "sleeper2",
  label: 'Wait for 3 seconds, then report: "sleeper 2 is back". Do not inspect or modify files.',
  status: "completed",
  output: "sleeper 2 is back\nFull task record: /tmp/sleeper2.md",
}

function registerScriptRenderer(): void {
  registerToolRenderer({ tool: "bash", compactTitle: (title) => `${title.split("\n")[1]} · compacted` })
}

test("startup banner places the terminal mark beside session details", async () => {
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    scrollback.appendHeader({ kind: "banner", model: "claude-sonnet-4", cwd: "~/Projects/xal" })

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    const cursor = terminalGlyph("█", "|")
    const mark = cursor === "█" ? ["▀█▄  ▄█▀", "  ████  ", "▄█▀  ▀█▄"] : ["\\      /", "   XX   ", "/      \\"]
    expect(rows).toEqual([
      "",
      `  ${mark[0]} ${cursor}  v${appInfo.version}`,
      `  ${mark[1]} ${cursor}  claude-sonnet-4`,
      `  ${mark[2]} ${cursor}  ~/Projects/xal`,
    ])
  } finally {
    setup.renderer.destroy()
  }
})

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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    scrollback.append({
      kind: "tool",
      tool: "wait_agent",
      title: "Wait for task-agent activity",
      readOnly: true,
      denial: undefined,
      output: "wait ended",
      preview: undefined,
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

test("live and replayed exploration share a compact row without hiding individual calls or failures", async () => {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  const rows = () =>
    setup.externalOutput
      .take()
      .flatMap((commit) => commit.rows)
      .map((row) => row.trim())
      .filter(Boolean)
  const removeRenderer = registerLiveToolRenderer({
    tool: "read",
    failed(output) {
      if (output === "legacy read result") throw new Error("unknown read format")
      return false
    },
  })
  try {
    await setup.renderer.setupTerminal()
    for (const replay of [false, true]) {
      const view = new Scrollback(
        setup.renderer,
        0,
        () => {},
        { showOutputs: false, showThinking: false, scrollbackRows: 0 },
        "Ctrl+O",
      )
      const tool = (name: string, title: string, extra: Partial<ToolBlock> = {}) =>
        view.append({
          kind: "tool",
          tool: name,
          title,
          output: `result-${title}`,
          preview: undefined,
          readOnly: true,
          expanded: false,
          denial: undefined,
          execution: undefined,
          elapsed: undefined,
          ...extra,
        })
      if (replay) view.beginReplay()
      tool("read", "first.ts")
      view.append({ kind: "hook", text: "after tool" })
      view.append({ kind: "reasoning", text: "inspect related code" })
      tool("glob", "*.ts", { output: "result-*.ts: fixture (interrupted by user)" })
      tool("grep", "needle")
      if (!replay) expect(view.explorationPreview).toBe("Explored · 1 read, 2 searches · needle")
      expect(rows()).toEqual([])
      tool("read", "missing.ts", { output: "Tool failed: missing file" })
      tool("grep", "private", { denial: "policy" })
      tool("read", "skipped.ts", { output: "Interrupted by user before execution." })
      tool("grep", "cancelled", { output: "(interrupted by user)" })
      tool("read", "legacy.ts", { output: "legacy read result" })
      tool("read", "last.ts")
      view.finishTools()
      if (replay) view.endReplay()
      expect(rows()).toEqual([
        "Explored · 1 read, 2 searches · needle",
        expect.stringContaining("missing file"),
        expect.stringContaining("blocked"),
        expect.stringContaining("interrupted"),
        expect.stringContaining("interrupted"),
        expect.stringContaining("legacy.ts"),
        "read renderer failed: unknown read format",
        "Explored · 1 read · last.ts",
      ])
      view.setExpanded(true)
      const expanded = rows()
      expect(expanded.filter((row) => row.includes("result-"))).toEqual(
        expect.arrayContaining([
          expect.stringContaining("result-first.ts"),
          expect.stringContaining("result-*.ts"),
          expect.stringContaining("result-needle"),
          expect.stringContaining("result-last.ts"),
        ]),
      )
      expect(expanded.join("\n")).toMatch(/read first\.ts[\s\S]*after tool[\s\S]*glob \*\.ts[\s\S]*grep needle/)
      expect(expanded.join("\n")).not.toContain("Explored")
    }
  } finally {
    removeRenderer()
    setup.renderer.destroy()
  }
})

test("a rebuild clears saved scrollback and re-prints one capped batch", async () => {
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    for (let index = 0; index < 30; index += 1) {
      scrollback.append({ kind: "info", text: `entry ${index}` })
    }
    setup.externalOutput.clear()

    scrollback.replay()

    const commits = setup.externalOutput.take()
    const rows = commits.flatMap((commit) => commit.rows)
    const entries = rows.filter((row) => row.includes("entry"))
    expect(commits.length).toBe(1)
    expect(rows.length).toBeLessThan(30)
    expect(rows.find((row) => row.trim().length > 0)).toContain("earlier transcript omitted")
    expect(entries[0]).toContain("entry 20")
    expect(entries.at(-1)).toContain("entry 29")
  } finally {
    setup.renderer.destroy()
  }
})

test("a height-only resize re-prints the transcript", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    scrollback.append({ kind: "info", text: "survives vertical resize" })
    setup.externalOutput.clear()

    setup.resize(80, 30)
    scrollback.reflow()

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows.some((row) => row.includes("survives vertical resize"))).toBe(true)
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
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
    const rows = commits.flatMap((commit) => commit.rows)
    const entries = rows.filter((row) => row.includes("entry"))
    expect(commits.length).toBe(1)
    expect(rows.find((row) => row.trim().length > 0)).toContain("earlier transcript omitted")
    expect(entries[0]).toContain("entry 20")
    expect(entries.at(-1)).toContain("entry 29")
  } finally {
    setup.renderer.destroy()
  }
})

test("a tool block leading the resumed batch separates from the omission notice", async () => {
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    scrollback.beginReplay()
    for (let index = 0; index < 30; index += 1) {
      scrollback.append({
        kind: "tool",
        tool: "bash",
        title: `cmd ${index}`,
        readOnly: true,
        denial: undefined,
        output: "",
        preview: undefined,
        execution: undefined,
        elapsed: undefined,
        expanded: false,
      })
    }

    scrollback.endReplay()

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows[1]).toContain("earlier transcript omitted")
    expect(rows[2]).toBe("")
    expect(rows[3]).toContain("cmd 10")
    expect(rows[4]).toContain("cmd 11")
    expect(rows.at(-1)).toContain("cmd 29")
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
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

test("a rebuild during a live stream re-prints the stream once", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
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
      { showOutputs: false, showThinking: false, scrollbackRows: 0 },
      undefined,
    )
    scrollback.append({ kind: "info", text: "before the stream" })
    scrollback.appendStream("text", "streamed paragraph one\n\nstreamed paragraph two\n\n")
    setup.externalOutput.clear()

    scrollback.replay()
    scrollback.endStream()

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows.filter((row) => row.includes("before the stream")).length).toBe(1)
    expect(rows.filter((row) => row.includes("streamed paragraph one")).length).toBe(1)
    expect(rows.filter((row) => row.includes("streamed paragraph two")).length).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("a live stream is charged to the scrollback row budget", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
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
      { showOutputs: false, showThinking: false, scrollbackRows: 20 },
      undefined,
    )
    for (let index = 0; index < 30; index += 1) {
      scrollback.append({ kind: "info", text: `entry ${index}` })
    }
    scrollback.appendStream("text", `${Array.from({ length: 30 }, (_, row) => `stream row ${row}`).join("\n\n")}\n\n`)
    setup.externalOutput.clear()

    scrollback.replay()

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows.some((row) => row.includes("earlier transcript omitted"))).toBe(true)
    expect(rows.filter((row) => row.includes("entry")).length).toBe(0)
  } finally {
    setup.renderer.destroy()
  }
})

test("a block that would overflow the row budget is dropped, including the oldest", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
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
      { showOutputs: false, showThinking: false, scrollbackRows: 5 },
      undefined,
    )
    for (let index = 0; index < 3; index += 1) {
      scrollback.append({ kind: "info", text: `entry ${index}` })
    }
    setup.externalOutput.clear()

    scrollback.replay()

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    expect(rows.filter((row) => row.includes("entry")).length).toBe(2)
    expect(rows.some((row) => row.includes("entry 0"))).toBe(false)
    expect(rows.some((row) => row.includes("entry 2"))).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})

test("a collapsed tool stays one line while naming the command and why it failed", async () => {
  registerScriptRenderer()
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
      { showOutputs: false, showThinking: false, scrollbackRows: 40 },
      undefined,
    )
    scrollback.append({
      kind: "tool",
      tool: "bash",
      title: "set -e\nrm -rf /tmp/example\nbun run checks",
      readOnly: false,
      denial: undefined,
      output: "first line of output\nsecond line of output\nthird line of output",
      preview: undefined,
      execution: { status: "exited", exitCode: 1 },
      elapsed: "2s",
      expanded: false,
    })

    const rows = setup.externalOutput.take().flatMap((commit) => commit.rows)
    const text = rows.join("\n")
    expect(text).toContain("rm -rf /tmp/example · compacted")
    expect(text).not.toContain("bash set -e")
    expect(text).toContain("exit 1")
    expect(text).not.toContain("failed")
    expect(text).not.toContain("third line of output")
  } finally {
    setup.renderer.destroy()
  }
})

test("replay preserves legacy result bodies and tool failure status when replacement renderers throw", async () => {
  const setup = await createTestRenderer({
    width: 90,
    height: 24,
    footerHeight: 1,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  await setup.renderer.setupTerminal()
  const scrollback = new Scrollback(
    setup.renderer,
    0,
    () => {},
    { showOutputs: true, showThinking: false, scrollbackRows: 40 },
    undefined,
  )
  const result = {
    kind: "tool",
    tool: "versioned-counter",
    title: "Count",
    readOnly: true,
    expanded: true,
    denial: undefined,
    preview: undefined,
    execution: undefined,
    elapsed: undefined,
  } satisfies Omit<ToolBlock, "output">
  const legacy = "This legacy counter returned a sentence instead of a number"
  const rejected = "Counting was declined by this tool"
  scrollback.append({ ...result, output: legacy })
  const remove = registerLiveToolRenderer({
    tool: result.tool,
    failed: (output) => output === rejected || output === legacy,
    summarize(output) {
      if (output === rejected) return "count declined"
      if (output !== "3") throw new Error("expected numeric output")
      return "3 counted"
    },
    renderOutput(output) {
      if (output === rejected) throw new Error("unknown result format")
      return { content: t`Count: ${output}`, rows: 1 }
    },
  })
  try {
    scrollback.append({ ...result, output: "3" })
    scrollback.append({ ...result, output: rejected })
    setup.externalOutput.clear()
    scrollback.replay()
    const text = setup.externalOutput
      .take()
      .flatMap((commit) => commit.rows)
      .join("\n")
    expect(text).toContain(legacy)
    expect(text).toContain("1 line x")
    expect(text).toContain("versioned-counter renderer failed: expected numeric output")
    expect(text).toContain("3 counted")
    expect(text).toContain("Count: 3")
    expect(text).toContain("count declined x")
    expect(text).toContain(rejected)
    expect(text).toContain("versioned-counter renderer failed: unknown result format")
  } finally {
    remove()
    setup.renderer.destroy()
  }
})

test("an expanded multi-line command keeps every wrapped line of the script", async () => {
  registerScriptRenderer()
  const setup = await createTestRenderer({
    width: 60,
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
      { showOutputs: true, showThinking: false, scrollbackRows: 40 },
      undefined,
    )
    scrollback.append({
      kind: "tool",
      tool: "bash",
      title: `set -e\necho ${"abcdefghij".repeat(12)}\necho final-line`,
      readOnly: false,
      denial: undefined,
      output: "first output\nsecond output",
      preview: undefined,
      execution: { status: "exited", exitCode: 0 },
      elapsed: "1s",
      expanded: true,
    })

    const text = setup.externalOutput
      .take()
      .flatMap((commit) => commit.rows)
      .join("\n")
    expect(text).toContain("echo final-line")
    expect(text).toContain("second output")
  } finally {
    setup.renderer.destroy()
  }
})
