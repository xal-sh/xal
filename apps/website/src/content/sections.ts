import { INSTALL_COMMAND } from "../site.ts"
import type { Block } from "../tui/blocks.ts"

export { DOCS_PATH, INSTALL_COMMAND, REPOSITORY, SITE_URL } from "../site.ts"

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
      { kind: "title", text: "Xal terminal coding harness" },
      {
        kind: "paragraph",
        text: "Xal is an open-source terminal coding harness with a headless agent core where every capability, including the interface, is a plugin. It gives coding agents the tools to inspect repositories, edit files, run commands, use language servers, connect to MCP servers, and complete real development work from a terminal.",
      },
      {
        kind: "paragraph",
        text: "The default terminal interface ships as one compiled binary for macOS, Linux, and Windows. Xal supports multiple AI providers, reusable skills and commands, persistent sessions, background jobs, sub-agents, worktree isolation, code review, and project-specific instructions without requiring a JavaScript runtime after installation.",
      },
      {
        kind: "paragraph",
        text: "Xal starts with a small headless agent loop. Everything around it is a plugin: the terminal interface, AI providers, tools, language servers, MCP bridge, memory, skills, code review, and workflow hooks. Built-in features use the same plugin API available to project and user extensions, so the default harness is a starting point rather than a fixed product boundary.",
      },
      {
        kind: "paragraph",
        text: "Teams can add or replace individual capabilities, define custom modes and commands, register a different interface, and shape Xal around their own development process. Plugins remain independent by design and may not depend on one another, which keeps each customization removable and prevents the harness from turning into a tightly coupled framework.",
      },
      {
        kind: "paragraph",
        text: "Xal is currently in beta and is developed in public under the MIT License. Read the [Xal documentation](/docs), inspect the [source code](https://github.com/xal-sh/xal), review [developer resources](/developers), or use the [official CLI installation guide](/cli) to get started.",
      },
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
      {
        label: "Approve and build",
        description: "Restore the previous writable mode, or normal mode, and begin implementing.",
      },
      {
        label: "Clear context and build",
        description: "Start a new session that carries only this plan. Context: 45% used.",
      },
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
        description: "ChatGPT, GitHub Copilot, Grok, DeepSeek and Qwen in the box; more providers plug in",
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

export const contact: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "title", text: "Contact Xal" },
      {
        kind: "paragraph",
        text: "Xal is an open-source project developed in public. For product questions, installation help, bug reports, and feature requests, use the [Xal GitHub issue tracker](https://github.com/xal-sh/xal/issues). Search existing issues first, then open a new issue with the Xal version, operating system, installation method, expected behavior, and the smallest reproduction you can provide.",
      },
      {
        kind: "paragraph",
        text: "For implementation questions, include relevant configuration with credentials removed, the command that failed, and the complete error output. Public issues are the preferred support channel because answers remain searchable for other users and maintainers can connect a report directly to code, documentation, or a release milestone.",
      },
      {
        kind: "paragraph",
        text: "Do not post API keys, access tokens, private repository content, personal data, or unredacted logs in a public issue. If a report describes a security vulnerability, do not publish exploit details. Open an issue that asks the maintainers to establish a private reporting channel, but leave all sensitive technical details out of that issue.",
      },
      {
        kind: "paragraph",
        text: "Xal does not currently offer paid support, a sales line, or a public telephone number. The canonical website is [xal.sh](https://xal.sh), the source repository is [xal-sh/xal](https://github.com/xal-sh/xal), and project documentation is available at [xal.sh/docs](/docs).",
      },
    ],
  },
]

export const privacy: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "title", text: "Xal privacy notice" },
      {
        kind: "paragraph",
        text: "The xal.sh website is a public documentation and download site for Xal. It does not provide user accounts, accept payments, or ask visitors to submit personal information. The interactive terminal demonstration runs in your browser. It stores only your selected light or dark theme in browser localStorage so that the preference can be restored on a later visit.",
      },
      {
        kind: "paragraph",
        text: "The website does not include first-party analytics, advertising trackers, or marketing cookies in this codebase. Hosting infrastructure may process standard request data such as IP address, user agent, requested URL, timestamp, and security signals to deliver the site, prevent abuse, and operate network logs. Requests for releases, issues, and source code follow links to GitHub and are then governed by GitHub's privacy terms.",
      },
      {
        kind: "paragraph",
        text: "The Xal command-line application runs on your machine and reads project files only through tools available to the active agent session and its permission rules. When you configure an AI provider, MCP server, or another external integration, data sent to that service is governed by your configuration and that service's terms. Review provider settings before sending private source code or personal data.",
      },
      {
        kind: "paragraph",
        text: "You can remove the website theme preference at any time by clearing site data for xal.sh. Privacy questions and correction requests can be raised through the [public contact channel](/contact). This notice applies to the xal.sh website and the official Xal project resources it describes; third-party plugins and services may have separate practices.",
      },
    ],
  },
]

export const developers: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "title", text: "Xal developer resources" },
      {
        kind: "paragraph",
        text: "Build integrations against Xal using its public website API, OpenAPI schema, terminal CLI, plugin system, and MCP client support. The website API is versioned under `/api/v1` and returns JSON. It currently exposes canonical product and integration metadata through `GET /api/v1/product`, with no account or API key required.",
      },
      { kind: "heading", text: "Public API" },
      {
        kind: "paragraph",
        text: "Fetch [the product endpoint](/api/v1/product) for the current Xal version, support status, install command, supported platforms, capabilities, and canonical resource links. Use the machine-readable [Xal OpenAPI specification](/openapi.json) to generate a client or an LLM function definition. API errors use a stable JSON object with an error code, message, and resolution hint.",
      },
      { kind: "code", lines: ["curl -s https://xal.sh/api/v1/product", "curl -s https://xal.sh/openapi.json"] },
      { kind: "heading", text: "Authentication and webhooks" },
      {
        kind: "paragraph",
        text: "The public read-only API does not require authentication. Xal does not currently publish a hosted account API or webhook service, so agents should not invent credentials or webhook endpoints. The API is cacheable public metadata and is subject to normal edge abuse protection.",
      },
      { kind: "heading", text: "CLI, plugins, and MCP" },
      {
        kind: "paragraph",
        text: "Install and automate the [official Xal CLI](/cli), read the [plugin guide](/docs/plugins), or configure external Model Context Protocol servers with the [MCP integration guide](/mcp). Xal is an MCP client and can consume tools, resources, and prompts from connected servers; xal.sh does not claim to host a public Xal MCP server.",
      },
    ],
  },
]

export const cli: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "title", text: "Official Xal CLI" },
      {
        kind: "paragraph",
        text: "The official Xal command-line tool is the `xal` native binary. It starts the terminal coding harness in the current project and can be scripted from POSIX-compatible shells. The beta installer selects the correct x64 or arm64 build for macOS, Linux, or Windows environments using Git Bash, MSYS2, or Cygwin.",
      },
      { kind: "code", lines: [INSTALL_COMMAND, "xal", "xal --mode plan", "xal update"] },
      {
        kind: "paragraph",
        text: "The default install location is `~/.local/bin`. Pass installer options to select another path, and make sure that path is present in `PATH`. Xal ships as one compiled binary, so the installed CLI does not require Node.js, Bun, Python, or a package manager at runtime.",
      },
      {
        kind: "paragraph",
        text: "Use plan mode when an agent should investigate without modifying files, normal mode for approval-gated development, and yolo mode only when unattended writes are intentional. The [installation guide](/docs/install) documents supported targets, checksums, custom paths, beta channels, and release behavior. Source and release history are available in the [official repository](https://github.com/xal-sh/xal).",
      },
    ],
  },
]

export const mcp: Block[] = [
  {
    kind: "doc",
    nodes: [
      { kind: "title", text: "Xal and MCP servers" },
      {
        kind: "paragraph",
        text: "Xal can connect to Model Context Protocol servers and expose their tools, resources, and prompts to an agent session. Configure each server independently in Xal configuration using a local stdio command or a remote streamable HTTP URL. MCP capabilities remain separate from built-in plugins and from every other MCP integration.",
      },
      {
        kind: "paragraph",
        text: "Use MCP when a coding task needs an external system such as an issue tracker, design tool, cloud platform, database, or internal documentation service. Apply narrow permissions to imported tools, keep credentials outside committed project files, and verify a server's trust boundary before allowing mutating calls.",
      },
      {
        kind: "paragraph",
        text: "The [Xal integrations documentation](/docs/integrations) contains configuration shapes and transport guidance. Xal acts as an MCP client; the xal.sh domain does not currently host a public MCP endpoint. Agents looking for Xal developer interfaces should use the [public REST API](/developers), the [OpenAPI specification](/openapi.json), or the local plugin API instead of guessing an MCP server URL.",
      },
    ],
  },
]

export const installIntro: Block = {
  kind: "doc",
  nodes: [
    { kind: "paragraph", text: "Xal is currently in beta. Only beta releases are available." },
    { kind: "paragraph", text: "One thing first: Xal does not touch your machine without asking." },
  ],
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
      { text: "resolving xal v0.0.1-beta.42 (darwin-arm64)…", tone: "plain" },
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
