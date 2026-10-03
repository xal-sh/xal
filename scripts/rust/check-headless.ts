import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isRecord } from "../../apps/cli/src/lib/json"
import { loadSession } from "../../apps/cli/src/sessions/store"
import { readProviderUsageSummary } from "../../apps/cli/src/usage/summary"
import { profilerTurnObservations } from "../context-efficiency"

const binary = resolve(process.argv[2] ?? "target/debug/xal-rust")
const root = await mkdtemp(join(tmpdir(), "xal-native-headless-"))

function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: `fc_${id}`,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    },
  }
}

function answer(text: string) {
  return [
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "message_fixture",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed",
      },
    },
  ]
}

try {
  for (const compact of [false, true]) {
    const home = join(root, compact ? "compact-home" : "home")
    const workspace = join(root, compact ? "compact-workspace" : "workspace")
    await mkdir(home)
    await mkdir(workspace)
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({
        profiles: {
          fixture: { name: "Fixture", provider: "openai", credential: { type: "api_key", key: "synthetic-key" } },
        },
      }),
    )
    await writeFile(join(workspace, "sample.txt"), compact ? "old history content\n".repeat(1000) : "before\n")
    if (compact)
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({
          contextWindows: { openai: { "gpt-4.1": 20000 } },
          compactionLimits: { openai: { "gpt-4.1": 4000 } },
        }),
      )
    const replies = compact
      ? [
          [call("read", "read", { file_path: "sample.txt" })],
          answer("Read sample.txt; continue the request."),
          answer("fixture answer"),
        ]
      : [
          [call("read", "read", { file_path: "sample.txt" })],
          [call("edit", "edit", { file_path: "sample.txt", old_string: "before", new_string: "after" })],
          [call("verify", "read", { file_path: "sample.txt" })],
          answer("fixture answer"),
        ]
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body: unknown = await request.json()
        if (!isRecord(body) || !Array.isArray(body.input)) return new Response("bad request", { status: 400 })
        const reply = replies[requests++]
        if (!reply) return new Response("unexpected request", { status: 400 })
        const events = [
          ...reply,
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 100, output_tokens: 5 } },
          },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      const child = Bun.spawn(
        [binary, "run", "--profile", "--format", "jsonl", "--model", "gpt-4.1", "fixture prompt"],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: home,
            XAL_HOME: home,
            XAL_OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
            NO_PROXY: "*",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20000)
      let stdout: string
      let stderr: string
      let code: number
      try {
        ;[stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
      } finally {
        clearTimeout(timeout)
      }
      if (code !== 0 || stderr || requests !== replies.length)
        throw new Error(`headless run failed: ${code}: ${stderr}\n${stdout}`)
      let rounds = 0
      let tools = 0
      let outputTokens = 0
      for (const line of stdout.trim().split("\n")) {
        const event: unknown = JSON.parse(line)
        if (!isRecord(event) || typeof event.type !== "string")
          throw new Error("stdout is not an eval-compatible event")
        if (event.type === "tool_started") tools += 1
        if (event.type === "context_updated") {
          if (!isRecord(event.context) || typeof event.context.outputTokens !== "number")
            throw new Error("invalid usage event")
          rounds += 1
          outputTokens += event.context.outputTokens
        }
      }
      if (rounds !== (compact ? 2 : 4) || tools !== (compact ? 1 : 3) || outputTokens !== rounds * 5)
        throw new Error("eval usage observation did not match")
      const journals = (await readdir(join(home, "sessions"), { recursive: true })).filter((name) =>
        name.endsWith(".jsonl"),
      )
      if (journals.length !== 1) throw new Error("missing native session journal")
      const path = join(home, "sessions", journals[0]!)
      const before = await readFile(path, "utf8")
      const session = await loadSession(path)
      if (
        !session ||
        session.items.length !== (compact ? 2 : 8) ||
        session.items[0]?.type !== (compact ? "compaction" : "user_message") ||
        session.items.at(-1)?.type !== "assistant_message"
      )
        throw new Error("legacy reader rejected native session")
      const profile = await profilerTurnObservations(join(home, "profiler"))
      if (profile.length !== 1 || profile[0]?.kind !== "primary" || profile[0].turns[0]?.length !== rounds)
        throw new Error("legacy profiler reader rejected native request/turn boundaries")
      const usage = await readProviderUsageSummary(join(home, "usage"), session.meta.id)
      if (
        usage.session.outputTokens !== replies.length * 5 ||
        usage.allTime.totalInputTokens !== replies.length * 100 ||
        usage.weekly.requests !== replies.length ||
        usage.daily.reduce((total, day) => total + day.requests, 0) !== replies.length
      )
        throw new Error("legacy usage reader rejected native accounting or calendar attribution")
      if (before !== (await readFile(path, "utf8"))) throw new Error("legacy reader repaired a native journal")
      if (before.includes("synthetic-key")) throw new Error("credential leaked to journal")
      if (!compact && (await readFile(join(workspace, "sample.txt"), "utf8")) !== "after\n")
        throw new Error("fixture edit did not persist")
    } finally {
      await server.stop(true)
    }
  }
  console.log(
    "Native read/edit/verify, compaction, eval JSONL, and legacy session/usage/profiler readers passed with synthetic homes",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
