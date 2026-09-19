import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { createProfile } from "../../config/credentials"
import { loadSettings, saveSettings } from "../../config/settings"
import { runGit } from "../../git/command"
import type { DecisionAnswer, DecisionRequest, DecisionService } from "../../providers/decision-types"
import { registerProvider } from "../../providers/registry"
import type { ConversationItem } from "../../providers/types"
import type { AgentEvent } from "../events"
import {
  prefetchedPaths,
  readAheadOrNotice,
  runReadAhead,
  withoutPrefetched,
  type ReadAheadOptions,
} from "./read-ahead"
import { setupAgentSessionTests } from "./test-support"

let workspace: string

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "xal-read-ahead-")))
  await mkdir(join(workspace, "src/lib/other"), { recursive: true })
  await writeFile(
    join(workspace, "src/app.ts"),
    'import { helper } from "./lib/helper"\nimport { other } from "./lib/other"\nexport const app = helper(other)\n',
  )
  await writeFile(join(workspace, "src/lib/helper.ts"), "export function helper() {}\n")
  await writeFile(join(workspace, "src/lib/other/index.ts"), "export const other = 1\n")
  await writeFile(join(workspace, "src/lib/config.env"), "KEY=1\n")
  await writeFile(join(workspace, "src/lib/large.ts"), `${"x".repeat(30_000)}\n`)
  await writeFile(join(workspace, "src/lib/extra.ts"), "export const extra = 1\n")
})

afterEach(() => rm(workspace, { recursive: true, force: true }))

function service(
  answer: (request: DecisionRequest) => Record<string, DecisionAnswer>,
  requests: DecisionRequest[] = [],
): DecisionService {
  return {
    async connections() {
      return []
    },
    async models() {
      return { models: [], source: "runtime" }
    },
    async evaluate(_profile, request) {
      requests.push(request)
      return { model: request.model, answers: answer(request), usage: {} }
    },
  }
}

function candidatePaths(request: DecisionRequest): string[] {
  const state = request.state
  if (typeof state === "string" || Array.isArray(state) || !Array.isArray(state.candidates)) return []
  return state.candidates.flatMap((candidate) =>
    typeof candidate === "object" && candidate && !Array.isArray(candidate) && typeof candidate.path === "string"
      ? [candidate.path]
      : [],
  )
}

function answersFor(request: DecisionRequest, score: (path: string) => number): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    candidatePaths(request).map((path, index) => [`file_${index}`, { type: "noul", noul: score(path) }]),
  )
}

function options(overrides: Partial<ReadAheadOptions> & Pick<ReadAheadOptions, "trigger">): ReadAheadOptions {
  return {
    items: [{ type: "user_message", text: "Fix the helper", images: [] }],
    cwd: workspace,
    service: service(() => ({})),
    profile: "profile",
    sessionId: "session",
    signal: new AbortController().signal,
    readFile: async (path) => `1\tcontent of ${relative(workspace, path)}`,
    ...overrides,
  }
}

const grepOutput =
  "Found 3 matching lines\nsrc/app.ts:3:export const app = helper(other)\nsrc/lib/helper.ts:1:export function helper() {}\nsrc/lib/config.env:1:KEY=1"

test("scores workspace paths found in search results, skips known files, and prefetches the winners", async () => {
  const requests: DecisionRequest[] = []
  const items: ConversationItem[] = [
    { type: "user_message", text: "Fix the helper", images: [] },
    { type: "tool_call", callId: "r1", name: "read", args: { file_path: "src/app.ts" } },
    { type: "tool_result", callId: "r1", output: "1\timport" },
  ]
  const prefetched = await runReadAhead(
    options({
      items,
      trigger: {
        type: "tools",
        outcomes: [
          { call: { type: "tool_call", callId: "g1", name: "grep", args: { pattern: "helper" } }, output: grepOutput },
        ],
      },
      service: service(
        (request) => answersFor(request, (path) => (path === "src/lib/helper.ts" ? 0.9 : 0.2)),
        requests,
      ),
      readFile: async (path) => (path.endsWith(".env") ? undefined : `1\tcontent of ${relative(workspace, path)}`),
    }),
  )
  expect(requests).toHaveLength(1)
  expect(candidatePaths(requests[0]!)).toEqual(["src/lib/helper.ts", "src/lib/config.env"])
  const state = JSON.stringify(requests[0]!.state)
  expect(state).toContain("Fix the helper")
  expect(state).toContain("export function helper() {}")
  expect(state).toContain('"tool":"grep"')
  expect(JSON.stringify(requests[0]!.questions.file_0)).toContain("`src/lib/helper.ts`")
  expect(prefetched).toBe(
    "[read-ahead] Prefetched src/lib/helper.ts because the next step likely needs it:\n1\tcontent of src/lib/helper.ts",
  )
  expect(prefetchedPaths(`Found 1 file\n\n${prefetched}`)).toEqual(["src/lib/helper.ts"])
})

test("resolves relative imports of a read file with its extension and index form, and never refetches", async () => {
  const requests: DecisionRequest[] = []
  const trigger: ReadAheadOptions["trigger"] = {
    type: "tools",
    outcomes: [
      {
        call: { type: "tool_call", callId: "r1", name: "read", args: { file_path: "src/app.ts" } },
        output:
          '1\timport { helper } from "./lib/helper"\n2\timport { other } from "./lib/other"\n(End of file - 3 lines)',
      },
    ],
  }
  const asker = service((request) => answersFor(request, () => 0.8), requests)
  const prefetched = await runReadAhead(options({ trigger, service: asker }))
  expect(candidatePaths(requests[0]!)).toEqual(["src/lib/helper.ts", "src/lib/other/index.ts"])
  expect(prefetchedPaths(prefetched ?? "")).toEqual(["src/lib/helper.ts", "src/lib/other/index.ts"])

  const items: ConversationItem[] = [
    { type: "user_message", text: "Fix the helper", images: [] },
    { type: "tool_call", callId: "r1", name: "read", args: { file_path: "src/app.ts" } },
    { type: "tool_result", callId: "r1", output: `1\timport\n\n${prefetched}` },
  ]
  expect(await runReadAhead(options({ trigger, items, service: asker }))).toBeUndefined()
  expect(requests).toHaveLength(1)
})

test("orders by probability, skips unreadable and oversized files, and caps the prefetch", async () => {
  const output = [
    "Found 6 files",
    "src/lib/large.ts",
    "src/lib/config.env",
    "src/lib/helper.ts",
    "src/lib/other/index.ts",
    "src/lib/extra.ts",
    "src/app.ts",
  ].join("\n")
  const scores: Record<string, number> = {
    "src/lib/large.ts": 1,
    "src/lib/config.env": 0.99,
    "src/lib/helper.ts": 0.7,
    "src/lib/other/index.ts": 0.8,
    "src/lib/extra.ts": 0.75,
    "src/app.ts": 0.9,
  }
  const prefetched = await runReadAhead(
    options({
      trigger: {
        type: "tools",
        outcomes: [{ call: { type: "tool_call", callId: "g1", name: "glob", args: { pattern: "**/*" } }, output }],
      },
      service: service((request) => answersFor(request, (path) => scores[path] ?? 0)),
      readFile: async (path) =>
        path.endsWith(".env")
          ? undefined
          : path.endsWith("large.ts")
            ? "x".repeat(25_000)
            : `content of ${relative(workspace, path)}`,
    }),
  )
  expect(prefetchedPaths(prefetched ?? "")).toEqual([
    "src/app.ts",
    "src/lib/other/index.ts",
    "src/lib/extra.ts",
    "src/lib/helper.ts",
  ])
})

test("returns nothing without candidates and rejects invalid decisions", async () => {
  const requests: DecisionRequest[] = []
  const outcome = (output: string): ReadAheadOptions["trigger"] => ({
    type: "tools",
    outcomes: [{ call: { type: "tool_call", callId: "g1", name: "grep", args: { pattern: "x" } }, output }],
  })
  expect(
    await runReadAhead(options({ trigger: outcome("No matches found"), service: service(() => ({}), requests) })),
  ).toBeUndefined()
  expect(requests).toHaveLength(0)
  await expect(runReadAhead(options({ trigger: outcome(grepOutput), service: service(() => ({})) }))).rejects.toThrow(
    "invalid read-ahead decisions",
  )
})

test("scores paths named in a prompt and files changed in the workspace", async () => {
  const requests: DecisionRequest[] = []
  await runGit(workspace, ["init", "--quiet"])
  await runGit(workspace, ["add", "src/lib"])
  await runGit(workspace, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"])
  const prefetched = await runReadAhead(
    options({
      items: [],
      trigger: { type: "prompt", text: "Rename helper in src/lib/helper.ts." },
      service: service((request) => answersFor(request, (path) => (path === "src/app.ts" ? 0.3 : 0.95)), requests),
    }),
  )
  expect(candidatePaths(requests[0]!)).toEqual(["src/lib/helper.ts", "src/app.ts"])
  expect(JSON.stringify(requests[0]!.state)).toContain('"type":"user_prompt"')
  expect(prefetchedPaths(prefetched ?? "")).toEqual(["src/lib/helper.ts"])
  const modelText = `Rename helper in src/lib/helper.ts.\n\n${prefetched}`
  expect(withoutPrefetched(modelText)).toBe("Rename helper in src/lib/helper.ts.")
  expect(withoutPrefetched("plain prompt")).toBe("plain prompt")
})

test("stays silent while TypeSafe AI is off and reports failures without prefetching", async () => {
  const harness = await setupAgentSessionTests("read-ahead-notice-")
  const events: AgentEvent[] = []
  let calls = 0
  try {
    await loadSettings()
    registerProvider({
      kind: "decision",
      id: "typesafe",
      name: "TypeSafe",
      aliases: [],
      async listModels() {
        return { models: [], source: "runtime" }
      },
      async evaluate() {
        calls++
        throw new Error("service unavailable")
      },
    })
    const trigger: ReadAheadOptions["trigger"] = {
      type: "tools",
      outcomes: [
        { call: { type: "tool_call", callId: "g1", name: "grep", args: { pattern: "helper" } }, output: grepOutput },
      ],
    }
    const request = {
      items: [],
      trigger,
      cwd: workspace,
      sessionId: "session",
      signal: new AbortController().signal,
      readFile: async () => "1\tcontent",
    }
    expect(await readAheadOrNotice(request, (event) => events.push(event))).toBeUndefined()
    expect(calls).toBe(0)
    expect(events).toEqual([])
    const profile = await createProfile("typesafe", "decisions", { type: "api_key", key: "test-key" })
    await saveSettings({ typesafeAI: { enabled: true, profile: profile.id } })
    expect(await readAheadOrNotice(request, (event) => events.push(event))).toBeUndefined()
    expect(calls).toBe(1)
    expect(events).toEqual([{ type: "error", message: "Jev read-ahead: service unavailable; nothing was prefetched." }])
  } finally {
    await saveSettings({ typesafeAI: { enabled: false } })
    await harness.cleanup()
  }
})
