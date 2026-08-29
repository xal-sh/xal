import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../../../agent/events"
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from "../scrollback/blocks"
import { ChildEventController, type ChildStatusBar } from "./child-events"

interface Recorder {
  blocks: Block[]
  status: string[]
  controller: ChildEventController
}

function recorder(streaming: boolean): Recorder {
  const blocks: Block[] = []
  const status: string[] = []
  let open: TextBlock | ReasoningBlock | undefined
  const transcript = streaming
    ? {
        append: (block: Block) => {
          open = undefined
          blocks.push(block)
        },
        appendStream: (kind: "text" | "reasoning", text: string) => {
          if (open && open.kind === kind) {
            open.text += text
            return
          }
          const created: TextBlock | ReasoningBlock =
            kind === "text" ? { kind: "text", text } : { kind: "reasoning", text }
          open = created
          blocks.push(created)
        },
        endStream: () => {
          if (!open) return false
          open = undefined
          return true
        },
      }
    : {
        append: (block: Block) => {
          blocks.push(block)
        },
        appendStream: () => {},
        endStream: () => false,
      }
  const statusBar: ChildStatusBar = {
    setState: (state) => status.push(`state:${state}`),
    setMode: (mode) => status.push(`mode:${mode}`),
    setModel: (model) => status.push(`model:${model}`),
    setThinking: (thinking) => status.push(`thinking:${thinking ?? "off"}`),
    setUsage: (context) => status.push(`usage:${JSON.stringify(context)}`),
    setTurnOutcome: (outcome) => status.push(`turn:${outcome}`),
  }
  return { blocks, status, controller: new ChildEventController(transcript, statusBar) }
}

function run(events: AgentEvent[]): Block[] {
  const recorded = recorder(false)
  for (const event of events) recorded.controller.handle(event)
  return recorded.blocks
}

function runStreamed(events: AgentEvent[]): Block[] {
  const recorded = recorder(true)
  for (const event of events) recorded.controller.handle(event)
  return recorded.blocks
}

function toolBlock(overrides: Partial<ToolBlock>): ToolBlock {
  return {
    kind: "tool",
    tool: "read",
    title: "file",
    readOnly: true,
    denial: undefined,
    output: "ok",
    execution: undefined,
    elapsed: undefined,
    expanded: false,
    ...overrides,
  }
}

describe("child event mapping", () => {
  test("accumulates text deltas into one block and skips the assistant fallback", () => {
    const blocks = runStreamed([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "assistant_message", text: "Hello" },
    ])
    expect(blocks).toEqual([{ kind: "text", text: "Hello" }])
  })

  test("assistant_message without streamed deltas becomes a text block", () => {
    expect(run([{ type: "assistant_message", text: "final report" }])).toEqual([{ kind: "text", text: "final report" }])
  })

  test("reasoning deltas accumulate and assistant text closes the reasoning stream", () => {
    const blocks = runStreamed([
      { type: "reasoning_summary_delta", text: "think" },
      { type: "reasoning_summary_delta", text: "ing" },
      { type: "reasoning_summary", text: "thinking" },
      { type: "assistant_message", text: "answer" },
    ])
    expect(blocks).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "text", text: "answer" },
    ])
  })

  test("reasoning_summary without streamed deltas becomes a reasoning block", () => {
    expect(run([{ type: "reasoning_summary", text: "thought" }])).toEqual([{ kind: "reasoning", text: "thought" }])
  })

  test("reasoning_delta is ignored", () => {
    expect(run([{ type: "reasoning_delta", text: "raw" }])).toEqual([])
  })

  test("a retry resets the streamed flags so the final message is kept", () => {
    const blocks = runStreamed([
      { type: "text_delta", text: "partial" },
      { type: "retry_scheduled", attempt: 2, maxAttempts: 3, delayMs: 5_000, message: "boom" },
      { type: "assistant_message", text: "recovered" },
    ])
    expect(blocks).toEqual([
      { kind: "text", text: "partial" },
      { kind: "info", text: "retrying in 5s · attempt 2/3 · boom" },
      { kind: "text", text: "recovered" },
    ])
  })

  test("user_message becomes a user block", () => {
    expect(run([{ type: "user_message", messageId: "m1", text: "do it", imageCount: 0, sentAt: 42 }])).toEqual([
      { kind: "user", text: "do it", imageCount: 0, sentAt: 42 },
    ])
  })

  test("tool_finished measures elapsed from its tool_started", () => {
    const blocks = run([
      { type: "tool_started", callId: "call-1", tool: "read", title: "file", readOnly: true },
      { type: "tool_updated", callId: "call-1", text: "progress" },
      { type: "tool_finished", callId: "call-1", tool: "read", title: "file", readOnly: true, output: "ok" },
    ])
    expect(blocks).toEqual([toolBlock({ elapsed: expect.any(String) })])
  })

  test("tool_finished without a start has no elapsed", () => {
    expect(
      run([{ type: "tool_finished", callId: "call-1", tool: "read", title: "file", readOnly: true, output: "ok" }]),
    ).toEqual([toolBlock({})])
  })

  test("shell_finished renders an expanded bash tool block", () => {
    const blocks = run([
      { type: "tool_started", callId: "call-1", tool: "bash", title: "ls", readOnly: true },
      {
        type: "shell_finished",
        messageId: "m1",
        callId: "call-1",
        input: "ls",
        command: "ls",
        output: "ok",
        readOnly: true,
      },
    ])
    expect(blocks).toEqual([toolBlock({ tool: "bash", title: "ls", expanded: true, elapsed: expect.any(String) })])
  })

  test("denials surface through the shell tool block", () => {
    const blocks = run([
      { type: "tool_started", callId: "call-1", tool: "bash", title: "rm", readOnly: false },
      {
        type: "shell_finished",
        messageId: "m1",
        callId: "call-1",
        input: "rm",
        command: "rm",
        output: "denied",
        readOnly: false,
        denial: "policy",
      },
    ])
    expect(blocks).toEqual([
      toolBlock({
        tool: "bash",
        title: "rm",
        readOnly: false,
        denial: "policy",
        output: "denied",
        expanded: true,
        elapsed: expect.any(String),
      }),
    ])
  })

  test("hook_finished becomes a hook block", () => {
    expect(
      run([{ type: "hook_finished", hook: "guard", event: "before_tool", action: "continued", elapsedMs: 12 }]),
    ).toEqual([{ kind: "hook", text: "hook: guard · before_tool · continued · 12ms" }])
  })

  test("background_results become background blocks with process log paths", () => {
    expect(
      run([
        {
          type: "background_results",
          results: [
            { kind: "agent", id: "agent-1", task: "research", status: "completed", output: "done" },
            { kind: "process", id: "proc-1", command: "bun test", status: "failed", output: "", record: "/tmp/log" },
            {
              kind: "process",
              id: "proc-2",
              command: "bun dev",
              status: "failed",
              output: "",
              record: "/tmp/log2",
              recordCapped: true,
            },
          ],
        },
      ]),
    ).toEqual([
      { kind: "background", id: "agent-1", label: "research", status: "completed", output: "done" },
      { kind: "background", id: "proc-1", label: "bun test", status: "failed", output: "", record: "/tmp/log" },
      {
        kind: "background",
        id: "proc-2",
        label: "bun dev",
        status: "failed",
        output: "",
        record: "/tmp/log2 (capped)",
      },
    ])
  })

  test("a draft plan becomes a plan block and an approved plan an info block", () => {
    expect(
      run([
        { type: "plan_updated", plan: { status: "draft", path: "/tmp/project/plans/x.md", markdown: "# Plan" } },
        { type: "plan_updated", plan: { status: "approved", path: "/tmp/project/plans/x.md", markdown: "# Plan" } },
      ]),
    ).toEqual([
      { kind: "plan", path: "/tmp/project/plans/x.md", text: "# Plan" },
      { kind: "info", text: "plan approved · /tmp/project/plans/x.md" },
    ])
  })

  test("compacted becomes a compaction block", () => {
    expect(run([{ type: "compacted", summary: "kept the gist", replaced: 12, tokensBefore: 4_000 }])).toEqual([
      { kind: "compaction", state: "compacted", summary: "kept the gist", replaced: 12, tokensBefore: 4_000 },
    ])
  })

  test("workspace_changed becomes an info block", () => {
    expect(run([{ type: "workspace_changed", cwd: "/tmp/next", previous: "/tmp/prev" }])).toEqual([
      { kind: "info", text: "workspace: /tmp/prev → /tmp/next" },
    ])
  })

  test("interrupts and failures become info and error blocks", () => {
    expect(
      run([
        { type: "turn_interrupted" },
        { type: "turn_failed", message: "provider exploded" },
        { type: "error", message: "plain error" },
      ]),
    ).toEqual([
      { kind: "info", text: "Interrupted" },
      { kind: "error", text: "provider exploded" },
      { kind: "error", text: "plain error" },
    ])
  })

  test("status-bar-only and unreachable child events produce no blocks", () => {
    expect(
      run([
        { type: "state_changed", state: "idle" },
        { type: "turn_ended" },
        { type: "context_updated", context: { outputTokens: 5 } },
        { type: "context_window_changed" },
        { type: "model_changed", provider: "p", model: "m" },
        { type: "mode_changed", mode: "plan" },
        { type: "thinking_changed", thinking: undefined },
        { type: "tool_call_updated", callId: "c", tool: "t", args: {} },
        { type: "hook_started", hook: "h", event: "prompt" },
        { type: "session_started", id: "s", cwd: "/tmp", resumed: false, provider: "p", model: "m", mode: "plan" },
        { type: "session_replay_finished" },
        { type: "session_title_changed", title: "t" },
        { type: "conversation_rewound", messageId: "m", prompt: "p", removedMessages: 1, fileCount: 0 },
        { type: "conversation_redone", messageId: "m", prompt: "p", restoredMessages: 1, fileCount: 0 },
        { type: "queue_changed", entries: [] },
        { type: "queue_flushed", inputs: [] },
        { type: "agent_questions", questions: [] },
        { type: "approval_requested", callId: "c", tool: "t", title: "x", readOnly: true },
        { type: "elicitation_requested", requestId: "r", callId: "c", questions: [] },
        { type: "elicitation_resolved", callId: "c" },
        {
          type: "goal_updated",
          goal: {
            status: "active",
            id: "g",
            condition: "c",
            startedAt: 0,
            evaluatedTurns: 0,
            usage: {},
            evaluatorModel: "m",
            consecutiveNoToolTurns: 0,
          },
        },
        { type: "task_list_updated", tasks: [] },
      ]),
    ).toEqual([])
  })

  test("status-bar events update the sub status bar without blocks", () => {
    const events: AgentEvent[] = [
      { type: "state_changed", state: "streaming" },
      { type: "turn_ended", context: { outputTokens: 5 } },
      { type: "context_updated", context: { outputTokens: 7 } },
      { type: "mode_changed", mode: "plan" },
      { type: "model_changed", provider: "p", model: "m2" },
      { type: "thinking_changed", thinking: "low" },
    ]
    const recorded = recorder(false)
    for (const event of events) recorded.controller.handle(event)
    expect(recorded.blocks).toEqual([])
    expect(recorded.status).toEqual([
      "state:streaming",
      "turn:completed",
      'usage:{"outputTokens":5}',
      'usage:{"outputTokens":7}',
      "mode:plan",
      "model:m2",
      "thinking:low",
    ])
  })
})
