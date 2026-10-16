import { describe, expect, test } from "bun:test"
import { runCode } from "./runtime"

function run(code: string): Promise<string> {
  return runCode(
    code,
    async () => {
      throw new Error("unexpected tool call")
    },
    new AbortController().signal,
  )
}

describe("Code Mode runtime", () => {
  test("filters complete text results and chains tool calls", async () => {
    const calls: string[] = []
    const output = await runCode(
      `const first = JSON.parse(await callTool("webfetch", {url: "first"}));
       const second = JSON.parse(await callTool("webfetch", {url: first.next}));
       emit({value: second.value});`,
      async (_name, args) => {
        calls.push(String(args.url))
        return JSON.stringify({ next: "second", padding: "x".repeat(100_000), value: 42 })
      },
      new AbortController().signal,
    )
    expect(calls).toEqual(["first", "second"])
    expect(output).toBe('{"value":42}')
  })

  test("isolates state and exposes no ambient host APIs or module loader", async () => {
    expect(
      await run(
        "globalThis.secret = 42; emit(typeof process + ':' + typeof Bun + ':' + typeof fetch + ':' + typeof require + ':' + typeof setTimeout)",
      ),
    ).toBe("undefined:undefined:undefined:undefined:undefined")
    expect(await run("emit(typeof secret)")).toBe("undefined")
    await expect(run('await import("node:fs")')).rejects.toThrow()
    await expect(run("}); (function(){ return 42")).rejects.toThrow()
  })

  test("does not hide child failures caught by the program", async () => {
    await expect(
      runCode(
        'try { await callTool("read", {}) } catch {} emit("success")',
        async () => {
          throw new Error("permission denied")
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("permission denied")
  })

  test("bounds emitted output, heap, and synchronous execution", async () => {
    await expect(run('try { emit("x".repeat(40_000)) } catch {}')).rejects.toThrow("32 KiB")
    await expect(run("const x = new ArrayBuffer(128 * 1024 * 1024); emit(x.byteLength)")).rejects.toThrow()
    await expect(run("while (true) {}")).rejects.toThrow()
    expect(await run("emit(42)")).toBe("42")
  })

  test("rejects orphan promises and aborts unawaited child calls", async () => {
    await expect(run("await new Promise(() => {})")).rejects.toThrow("no pending tool calls")
    let aborted = false
    await expect(
      runCode(
        'callTool("read", {}); emit("done")',
        async (_name, _args, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            ),
          )
          signal.throwIfAborted()
          return "unreachable"
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("unawaited")
    expect(aborted).toBe(true)
  })

  test("propagates cancellation without waiting for an uncooperative tool or using disposed handles", async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<string>()
    const output = runCode(
      'await callTool("read", {})',
      () => {
        started.resolve()
        return pending.promise
      },
      controller.signal,
    )
    await started.promise
    controller.abort(new Error("cancelled"))
    await expect(output).rejects.toThrow("cancelled")
    pending.resolve("late result")
    await Bun.sleep(0)
    expect(await run("emit(42)")).toBe("42")
  })
})
