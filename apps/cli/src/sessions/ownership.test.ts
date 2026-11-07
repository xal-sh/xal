import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionWriter } from "./ownership"
import { SessionRecorder } from "./recorder"
import { loadSession } from "./store"

const complete = `${JSON.stringify({
  type: "meta",
  meta: {
    version: 2,
    id: "owned-session",
    cwd: "/workspace",
    provider: "provider",
    profile: "profile",
    model: "model",
    mode: "normal",
    startedAt: 123,
  },
})}\n`

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "xal-session-ownership-"))
  try {
    await run(join(directory, "session.jsonl"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("only one recorder owns a transcript and transferring ownership cannot release its successor", async () => {
  await fixture(async (path) => {
    await writeFile(path, complete)
    const writer = SessionWriter.acquire(path)
    const recorder = new SessionRecorder(() => {})
    recorder.attach(writer)
    writer.close()
    expect(() => SessionWriter.acquire(path)).toThrow("already open")
    await expect(loadSession(path, writer)).rejects.toThrow("released")
    recorder.item({ type: "assistant_message", text: "first owner" })
    await recorder.close()
    const next = SessionWriter.acquire(path)
    try {
      expect((await loadSession(path, next))?.items).toEqual([{ type: "assistant_message", text: "first owner" }])
      await expect(recorder.eventAndWait({ type: "turn_ended" })).rejects.toThrow("closed")
    } finally {
      next.close()
    }
  })
})

test("competing processes cannot append or repair until a crashed owner releases its OS lock", async () => {
  await fixture(async (path) => {
    const partial = `${complete}{"type":"item"`
    await writeFile(path, partial)
    const script = `
      import { SessionWriter } from ${JSON.stringify(join(import.meta.dir, "ownership.ts"))};
      import { loadSession } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
      const writer = SessionWriter.acquire(process.argv[1]);
      console.log("owned");
      for await (const chunk of Bun.stdin.stream()) {
        await loadSession(writer.path, writer);
        console.log("repaired");
      }
      writer.close();
    `
    const children = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, "--eval", script, path], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    try {
      const readers = children.map((child) => child.stdout.getReader())
      const first = await Promise.all(readers.map((reader) => reader.read()))
      const winnerIndex = first.findIndex((result) => new TextDecoder().decode(result.value).includes("owned"))
      expect(first.filter((result) => new TextDecoder().decode(result.value).includes("owned"))).toHaveLength(1)
      const loser = children[1 - winnerIndex]!
      expect(await loser.exited).not.toBe(0)
      expect(await new Response(loser.stderr).text()).toContain("already open")
      expect(await readFile(path, "utf8")).toBe(partial)
      expect((await loadSession(path))?.meta.id).toBe("owned-session")
      expect(await readFile(path, "utf8")).toBe(partial)
      const winner = children[winnerIndex]!
      winner.kill("SIGKILL")
      await winner.exited
      const recovered = SessionWriter.acquire(path)
      try {
        expect((await loadSession(path, recovered))?.meta.id).toBe("owned-session")
        expect(await readFile(path, "utf8")).toBe(complete)
      } finally {
        recovered.close()
      }
      for (const reader of readers) reader.releaseLock()
    } finally {
      for (const child of children) {
        child.kill()
        await child.exited
      }
    }
  })
}, 15_000)
