import type { Block } from "../tui/blocks.ts"

export const SITE_URL = "https://xal.sh"
export const DOCS_PATH = "/docs"
export const REPOSITORY = "https://github.com/xal-sh/xal"
export const INSTALL_COMMAND = "curl -fsSL https://xal.sh/install | sh"

export const MODEL = "gpt-5.6-sol"
export const THINKING = "xhigh"
export const CWD = "~/Projects/xal"

export const banner: Block = { kind: "banner", model: MODEL, cwd: CWD }

export const registered: Block = {
  kind: "info",
  text: "plugins: 15/15 registered",
}

export const hint: Block = {
  kind: "info",
  text: "type ~/~ to explore · `/help` lists every command",
}

export const startup: Block[] = [banner, registered]

export const about: Block[] = [
  {
    kind: "doc",
    nodes: [
      {
        kind: "paragraph",
        text: "A terminal coding harness with a headless agent core — where every capability, is a plugin.",
      },
      { kind: "paragraph", text: "One compiled binary. Your providers, your rules, your terminal." },
    ],
  },
  {
    kind: "tool",
    mutating: false,
    label: "read AGENTS.md",
    summary: "31 lines",
    elapsed: "0.2s",
    outcome: "success",
  },
  {
    kind: "tool",
    mutating: false,
    label: 'grep "registerPlugin" apps/cli/src',
    summary: "14 matches",
    elapsed: "0.4s",
    outcome: "success",
  },
]

export const landing: Block[] = [...startup, ...about, hint]

export const session: Block[] = [...startup, hint]

export const tools: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "heading", text: "Tools" },
      {
        kind: "list",
        items: [
          "`read` · `write` · `edit` — files, with a real diff for every change",
          "`bash` — risk-analyzed, compound commands split before they are judged",
          "`grep` · `glob` · `webfetch` — find things, fetch things",
          "`task` — delegate to a sub-agent and keep working",
          "`mermaid` — render adaptive diagrams with native terminal characters",
          "`lsp` · `mcp__*` — code intelligence and every MCP server you connect",
        ],
      },
      {
        kind: "paragraph",
        text: "Streaming, with live previews while a tool runs. Steer mid-flight or queue the next thought — it lands on the following step.",
      },
    ],
  },
  {
    kind: "tool",
    mutating: true,
    label: "edit apps/cli/src/agent/session/stream.ts",
    summary: "+12 −3",
    elapsed: "1.1s",
    outcome: "success",
    output: [
      { text: "@@ -84,7 +84,7 @@", tone: "hunk" },
      { number: "84", text: "   for (const part of stream) {", tone: "plain" },
      { number: "85", text: "-    if (!part.delta) continue", tone: "removed" },
      { number: "85", text: "+    if (!part.delta) { flushPending(); continue }", tone: "added" },
      { number: "86", text: "   emit(part.delta)", tone: "plain" },
    ],
  },
  {
    kind: "tool",
    mutating: false,
    label: "bash bun test src/agent",
    summary: "47 lines",
    elapsed: "3.2s",
    outcome: "success",
  },
  {
    kind: "tasks",
    progress: "2/4 completed",
    items: [
      { state: "completed", text: "Read the stream reducer" },
      { state: "completed", text: "Flush pending deltas on empty parts" },
      { state: "active", text: "Rewrite the retry path" },
      { state: "pending", text: "Update the session tests" },
    ],
  },
]

export const safety: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "heading", text: "Nothing runs without your say" },
      {
        kind: "paragraph",
        text: "A permission engine sits between the agent and your machine — `allow` / `ask` / `deny` per tool. When a rule says ask, it stops.",
      },
    ],
  },
  { kind: "tool", mutating: true, label: "bash rm -rf node_modules", summary: "denied", outcome: "error" },
  { kind: "tool", mutating: false, label: "read .env", summary: "blocked", outcome: "error" },
  { kind: "tool", mutating: true, label: "edit src/index.ts", summary: "plan mode", outcome: "error" },
  {
    kind: "doc",
    nodes: [
      {
        kind: "paragraph",
        text: "In *plan mode* it can only read. It investigates, writes the plan, and hands the decision back to you:",
      },
    ],
  },
  {
    kind: "choices",
    header: "Plan review",
    meta: "Question 1 of 1",
    question: "Review the implementation plan above. What should Xal do?",
    options: [
      { label: "Approve and build", description: "Switch to normal mode and begin implementing this plan." },
      { label: "Request changes", description: "Keep plan mode active so the proposal can be revised." },
    ],
    hint: "←→ questions · ↑↓ choose · 1-3 select · Enter save · Esc decline",
  },
  {
    kind: "doc",
    nodes: [
      {
        kind: "list",
        items: [
          "*custom modes* — ship your own `docs-only` or `ci` mode; `yolo` exists for when you mean it",
          "*secret redaction* — keys scrubbed from what the model sees, what is stored, and what is on screen",
          "*undo* — `/undo` rewinds the conversation *and* the files; worktree isolation when you want distance",
          "*workspace trust* — an untrusted folder cannot load project config or plugins",
        ],
      },
    ],
  },
]

export const plugins: Block[] = [
  {
    kind: "tool",
    mutating: false,
    label: "hooks 4 registered",
    summary: "4 lines",
    outcome: "success",
    output: [
      { text: "prompt        redact-tokens        project", tone: "plain" },
      { text: "beforeTool    block-prod-writes    project", tone: "plain" },
      { text: "afterTool     format-on-edit       user", tone: "plain" },
      { text: "turnEnd       notify-tmux          user", tone: "plain" },
    ],
  },
  {
    kind: "doc",
    nodes: [
      { kind: "heading", text: "Everything is a plugin" },
      {
        kind: "paragraph",
        text: "The core is a headless agent loop and nothing else. The terminal UI, the language servers, the MCP bridge, the code-review workflow, the model providers — all plugins, all removable, all built against the same API you would use.",
      },
      { kind: "paragraph", text: "One rule keeps it honest: ~no plugin may depend on another plugin.~" },
    ],
  },
  {
    kind: "diagram",
    core: "agent core",
    coreNote: "headless · small · readable",
    caption: "fig. 1 — the harness, exploded. every part detaches.",
    parts: [
      { name: "tui", description: "the default interface — register a different one and this page changes shape" },
      { name: "mcp", description: "tools, resources and prompts from any MCP server, stdio or http" },
      { name: "lsp", description: "definitions, references, call hierarchy, diagnostics — ts, python, rust, go" },
      {
        name: "providers",
        description: "ChatGPT, GitHub Copilot, DeepSeek and Qwen in the box; more providers plug in",
      },
      { name: "memory", description: "secure global memory that follows you across sessions" },
      { name: "code-review", description: "`/review` the diff before it ships" },
      { name: "skills", description: "`SKILL.md` packages plus markdown prompt commands with arguments" },
      {
        name: "yours",
        description: "hooks, tools, providers, whole interfaces — the same API the built-ins use",
        dashed: true,
      },
    ],
  },
]

export const agents: Block[] = [
  {
    kind: "agents",
    heading: "Running 2 agents…",
    rows: [
      {
        last: false,
        title: "Audit the diff renderer",
        metrics: "7 tool uses · 12.4K tokens",
        activity: 'bash: rg -n "classifyDiff" src',
      },
      { last: true, title: "Port the session tests", metrics: "2 tool uses · 3.1K tokens", activity: "Thinking…" },
    ],
  },
  {
    kind: "doc",
    nodes: [
      { kind: "heading", text: "Work on more than one thing" },
      {
        kind: "paragraph",
        text: "Sub-agents run in parallel, in their own git worktree when you want distance. Background bash jobs keep streaming while you talk — `job_output`, `job_status`, `job_kill`. Results land back in the transcript when they finish.",
      },
      {
        kind: "paragraph",
        text: "Sessions persist through all of it: `xal resume` reopens yesterday mid-thought, `/fork` branches an experiment, `/export` writes the whole exchange to markdown.",
      },
    ],
  },
]

export const installIntro: Block = {
  kind: "doc",
  nodes: [{ kind: "paragraph", text: "One thing first — xal does not touch your machine without asking." }],
}

export const installPending: Block = {
  kind: "tool",
  mutating: true,
  label: `bash ${INSTALL_COMMAND}`,
  summary: "needs approval",
  outcome: "pending",
}

export const installAllowed: Block[] = [
  {
    kind: "tool",
    mutating: true,
    label: `bash ${INSTALL_COMMAND}`,
    summary: "4 lines",
    elapsed: "6.8s",
    outcome: "success",
    output: [
      { text: "resolving xal v0.0.1 (darwin-arm64)…", tone: "plain" },
      { text: "downloading  75.2 MB  ████████████████████  100%", tone: "plain" },
      { text: "installed → ~/.local/bin/xal", tone: "plain" },
      { text: "run `xal` in any project to start", tone: "plain" },
    ],
  },
  {
    kind: "doc",
    nodes: [
      {
        kind: "paragraph",
        text: "One native binary, compiled with Bun. No runtime, no `node_modules`. Run it again on any machine:",
      },
    ],
  },
  { kind: "command", text: INSTALL_COMMAND },
  { kind: "doc", nodes: [{ kind: "paragraph", text: "Then type `xal` in any project." }] },
]

export const installDenied: Block[] = [
  {
    kind: "tool",
    mutating: true,
    label: `bash ${INSTALL_COMMAND}`,
    summary: "denied",
    outcome: "error",
  },
  {
    kind: "doc",
    nodes: [
      {
        kind: "paragraph",
        text: "Nothing ran. ~Good instinct — that is the entire point.~ The command when you want it:",
      },
    ],
  },
  { kind: "command", text: INSTALL_COMMAND },
]
