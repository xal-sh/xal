import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { settings } from "../../config/settings"
import { isRecord } from "../../lib/json"
import { nativeCodeSearch } from "../../native"
import type { DecisionRequest, DecisionService } from "../../providers/decision-types"
import { replaceSecretValues } from "../../secrets/redactor"
import type { ToolExecutionContext } from "../../tools/types"
import { codeSearchTool } from "./code-search"

async function workspace(run: (ctx: ToolExecutionContext) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "xal-code-search-"))
  const previous = settings().codeSearch
  settings().codeSearch = { strategy: "jev", profile: "decision-profile" }
  try {
    await mkdir(join(directory, ".git"))
    await run({
      cwd: await realpath(directory),
      directory,
      sessionId: "code-search-test",
      sessionKind: "primary",
      signal: new AbortController().signal,
      update() {},
    })
  } finally {
    settings().codeSearch = previous
    replaceSecretValues("code-search-test", [])
    await rm(directory, { recursive: true, force: true })
  }
}

function service(evaluate?: DecisionService["evaluate"]): DecisionService {
  return {
    async connections() {
      return [
        {
          profile: { id: "decision-profile", name: "decisions", provider: "typesafe" },
          provider: { id: "typesafe", name: "TypeSafe" },
        },
      ]
    },
    async models() {
      return { models: [{ kind: "decision", id: "jev-latest", name: "Jev" }], source: "runtime" }
    },
    evaluate:
      evaluate ??
      (async (_profile, request) => ({
        model: "jev-test",
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.5 }])),
        usage: { totalInputTokens: 100, outputTokens: 10 },
      })),
  }
}

test("local retrieval honors ignores, exclusions, scope, filters, and current line-numbered text", async () => {
  await workspace(async (ctx) => {
    await mkdir(join(ctx.cwd, "src"))
    await writeFile(join(ctx.cwd, ".gitignore"), "ignored.ts\n")
    await writeFile(join(ctx.cwd, "ignored.ts"), "ToolCallRunner ignored\n")
    await writeFile(join(ctx.cwd, ".env"), "ToolCallRunner=secret\n")
    await writeFile(join(ctx.cwd, "private.pem"), "ToolCallRunner private key\n")
    await writeFile(join(ctx.cwd, "binary.ts"), "ToolCallRunner\u0000binary")
    await writeFile(join(ctx.cwd, "large.ts"), "ToolCallRunner".repeat(50_000))
    await writeFile(join(ctx.cwd, "src/run.ts"), "first\nexport class ToolCallRunner {}\nlast\n")
    await writeFile(join(ctx.cwd, "src/other.js"), "ToolCallRunner javascript\n")
    await symlink(join(ctx.cwd, "src/run.ts"), join(ctx.cwd, "link.ts"))
    const result = await nativeCodeSearch({ cwd: ctx.cwd, query: "Where is tool call runner?" })
    expect(result.kind).toBe("completed")
    expect(result.skippedFiles).toBe(4)
    expect(result.passages.map((passage) => passage.path).sort()).toEqual(["src/other.js", "src/run.ts"])
    const filtered = await nativeCodeSearch({ cwd: ctx.cwd, query: "tool call runner", target: "src", glob: "*.ts" })
    expect(filtered.passages).toHaveLength(1)
    expect(filtered.passages[0]).toMatchObject({
      path: "src/run.ts",
      startLine: 1,
      endLine: 3,
      text: "first\nexport class ToolCallRunner {}\nlast\n",
    })
    await writeFile(join(ctx.cwd, "src/run.ts"), "updated ToolCallRunner\n")
    const fresh = await nativeCodeSearch({ cwd: ctx.cwd, query: "tool call runner", target: "src/run.ts" })
    expect(fresh.passages[0]?.text).toBe("updated ToolCallRunner\n")
    expect(
      (await nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: join(ctx.cwd, "src/run.ts") })).passages,
    ).toHaveLength(1)
    expect((await nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: "ignored.ts" })).passages).toHaveLength(0)
    await mkdir(join(ctx.cwd, "ignored-dir"))
    await writeFile(join(ctx.cwd, "ignored-dir/run.ts"), "ToolCallRunner ignored\n")
    await writeFile(join(ctx.cwd, ".gitignore"), "ignored.ts\nignored-dir/\n")
    expect((await nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: "ignored-dir" })).passages).toHaveLength(0)
    await expect(nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: ".." })).rejects.toThrow(
      "inside the workspace",
    )
    await expect(nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: "link.ts" })).rejects.toThrow("symlinks")
    await expect(nativeCodeSearch({ cwd: ctx.cwd, query: "runner", target: "missing" })).rejects.toThrow()
    await expect(nativeCodeSearch({ cwd: ctx.cwd, query: "runner", glob: "[" })).rejects.toThrow()
  })
})

test("bounds candidates and passages while keeping their exact source ranges", async () => {
  await workspace(async (ctx) => {
    const content = Array.from({ length: 200 }, (_, i) => `export const runner${i} = "héllo runner ${i}"`).join("\n")
    await writeFile(join(ctx.cwd, "long.ts"), `${"runner".repeat(400)}\n${content}`)
    for (let index = 0; index < 45; index++) await writeFile(join(ctx.cwd, `runner-${index}.ts`), content)
    const result = await nativeCodeSearch({ cwd: ctx.cwd, query: "runner" })
    expect(result.passages).toHaveLength(40)
    expect(result.matchedPassages).toBeGreaterThan(40)
    expect(result.skippedLines).toBe(1)
    for (const passage of result.passages) {
      const source = await readFile(join(ctx.cwd, passage.path), "utf8")
      expect(passage.text).toBe(
        source
          .split(/(?<=\n)/)
          .slice(passage.startLine - 1, passage.endLine)
          .join(""),
      )
      expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(1800)
      expect(passage.endLine - passage.startLine + 1).toBeLessThanOrEqual(40)
    }
  })
})

test("reranks in one redacted request and returns source excerpts without overlapping duplicates", async () => {
  await workspace(async (ctx) => {
    const secret = "code-search-test-secret"
    replaceSecretValues("code-search-test", [secret])
    await writeFile(join(ctx.cwd, "a.ts"), `runner runner runner\nconst token = "${secret}"\n`)
    await writeFile(join(ctx.cwd, "b.ts"), "export function runner() { return 'actual implementation' }\n")
    await writeFile(join(ctx.cwd, "c.ts"), Array.from({ length: 90 }, (_, i) => `runner ${i}`).join("\n"))
    const requests: DecisionRequest[] = []
    const tool = codeSearchTool(
      service(async (profile, request) => {
        expect(profile).toBe("decision-profile")
        requests.push(request)
        expect(JSON.stringify(request)).not.toContain(secret)
        expect(JSON.stringify(request)).toContain("[REDACTED]")
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(90_000)
        if (!isRecord(request.state) || !Array.isArray(request.state.passages)) throw new Error("missing passages")
        return {
          model: "jev-test",
          answers: Object.fromEntries(
            request.state.passages.map((entry, i) => [
              `passage_${i}`,
              { type: "noul", noul: isRecord(entry) && entry.path === "b.ts" ? 0.95 : 0.1 },
            ]),
          ),
          usage: { totalInputTokens: 100, outputTokens: 10 },
        }
      }),
    )
    const result = await tool.execute({ query: "Where is runner implemented?", limit: 5 }, ctx)
    expect(requests).toHaveLength(1)
    expect(result.output).toContain("Jev relevance ranking")
    expect(result.output.indexOf("b.ts:1-1")).toBeLessThan(result.output.indexOf("a.ts:1-2"))
    expect(result.output).toContain("1: export function runner() { return 'actual implementation' }")
    expect(result.output).not.toContain(secret)
    expect(result.output).toContain("Shortlist only")
    const ranges = [...result.output.matchAll(/c\.ts:(\d+)-(\d+)/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ])
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        expect(ranges[i]![1]! < ranges[j]![0]! || ranges[j]![1]! < ranges[i]![0]!).toBe(true)
      }
    }
  })
})

for (const length of [3, 45]) {
  test(`protects ${length}-line secrets before chunking and line numbering`, async () => {
    await workspace(async (ctx) => {
      const protectedLines = Array.from({ length }, (_, index) => `sensitive-value-${index}-private`)
      replaceSecretValues("code-search-test", [protectedLines.join("\n")])
      await writeFile(
        join(ctx.cwd, "runner.ts"),
        [
          ...Array.from({ length: 24 }, (_, index) => `runner lead ${index}`),
          ...protectedLines,
          "runner safe tail",
        ].join("\n"),
      )
      const tool = codeSearchTool(
        service(async (_profile, request) => {
          const sent = JSON.stringify(request)
          for (const line of protectedLines) expect(sent).not.toContain(line)
          expect(sent).toContain("[REDACTED]")
          return {
            model: "jev-test",
            answers: Object.fromEntries(
              Object.keys(request.questions).map((id, index, ids) => [
                id,
                { type: "noul", noul: (index + 1) / (ids.length + 1) },
              ]),
            ),
            usage: {},
          }
        }),
      )
      const result = await tool.execute({ query: "runner", limit: 10 }, ctx)
      expect(result.output).toContain("Jev relevance ranking")
      for (const line of protectedLines) expect(result.output).not.toContain(line)
      expect(result.output).toContain(`${25 + length}: runner safe tail`)
    })
  })
}

test("keeps fallback visible, skips Jev without candidates, and never falls back on cancellation", async () => {
  await workspace(async (ctx) => {
    await writeFile(join(ctx.cwd, "runner.ts"), "export function runner() {}\n")
    let calls = 0
    const failing = codeSearchTool(
      service(async () => {
        calls += 1
        throw new Error("TypeSafe unavailable")
      }),
    )
    expect((await failing.execute({ query: "runner" }, ctx)).output).toContain(
      "local ranking; Jev fallback: TypeSafe unavailable",
    )
    expect(calls).toBe(1)
    expect((await failing.execute({ query: "zzzznomatch" }, ctx)).output).toContain("no candidates")
    expect(calls).toBe(1)
    const invalid = codeSearchTool(service(async () => ({ model: "jev-test", answers: {}, usage: {} })))
    expect((await invalid.execute({ query: "runner" }, ctx)).output).toContain("invalid passage relevance score")
    const disconnected = service()
    disconnected.connections = async () => []
    expect((await codeSearchTool(disconnected).execute({ query: "runner" }, ctx)).output).toContain(
      "profile is not connected",
    )
    const controller = new AbortController()
    const cancelled = codeSearchTool(
      service(async () => {
        controller.abort()
        throw new Error("cancelled")
      }),
    )
    await expect(cancelled.execute({ query: "runner" }, { ...ctx, signal: controller.signal })).rejects.toThrow()
    await expect(failing.execute({ query: "runner" }, { ...ctx, signal: controller.signal })).rejects.toThrow()
    expect(calls).toBe(1)
    await expect(failing.execute({ query: "runner", path: "missing" }, ctx)).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

test("reranking has a short deadline and returns a local fallback on timeout", async () => {
  await workspace(async (ctx) => {
    await writeFile(join(ctx.cwd, "runner.ts"), "export function runner() {}\n")
    const tool = codeSearchTool(
      service(async (_profile, request) => {
        if (!request.signal) throw new Error("missing signal")
        const signal = request.signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }),
    )
    const started = performance.now()
    const result = await tool.execute({ query: "runner" }, ctx)
    expect(result.output).toContain("local ranking; Jev fallback:")
    expect(performance.now() - started).toBeLessThan(4500)
  })
}, 5000)

test("fits escaped candidate text into one bounded Jev request", async () => {
  await workspace(async (ctx) => {
    for (let i = 0; i < 45; i++) await writeFile(join(ctx.cwd, `runner-${i}.ts`), `runner ${'"'.repeat(1700)}\n`)
    let questions = 0
    const tool = codeSearchTool(
      service(async (_profile, request) => {
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(90_000)
        questions = Object.keys(request.questions).length
        return {
          model: "jev-test",
          answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.5 }])),
          usage: {},
        }
      }),
    )
    const result = await tool.execute({ query: "runner" }, ctx)
    expect(questions).toBeGreaterThan(0)
    expect(questions).toBeLessThan(40)
    expect(result.output).toContain("Jev relevance ranking")
  })
})

test("tool availability follows explicit settings and validates arguments", async () => {
  await workspace(async (ctx) => {
    const tool = codeSearchTool(service())
    const availability = { sessionId: ctx.sessionId, interactive: true, kind: "primary" as const, mode: "normal" }
    expect(tool.available?.(availability)).toBe(true)
    expect(tool.readOnly?.({}, ctx)).toBe(true)
    expect(tool.concurrency?.({}, ctx)).toBe("shared")
    for (const args of [
      { query: "" },
      { query: "x".repeat(2001) },
      { query: "runner", limit: 11 },
      { query: "runner", path: 2 },
    ]) {
      await expect(tool.execute(args, ctx)).rejects.toThrow()
    }
    settings().codeSearch = { strategy: "off" }
    expect(tool.available?.(availability)).toBe(false)
    await expect(tool.execute({ query: "runner" }, ctx)).rejects.toThrow("disabled")
  })
})
