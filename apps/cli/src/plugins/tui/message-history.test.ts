import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectMessageHistoryPath } from "../../config/paths"
import { createNativeSessionLock } from "../../native"
import { MessageHistory } from "./message-history"

test("history waits for another owner and recovers after a rejected save without changing memory", async () => {
  const home = await mkdtemp(join(tmpdir(), "xal-history-"))
  const previous = process.env.XAL_HOME
  process.env.XAL_HOME = home
  try {
    const history = await MessageHistory.load(home)
    const path = projectMessageHistoryPath(home)
    const owner = createNativeSessionLock(path)
    let saved = false
    const pending = history.record("first").then(() => {
      saved = true
    })
    try {
      await Bun.sleep(30)
      expect(saved).toBe(false)
      expect(history.older({ text: "draft", images: [] })).toBeUndefined()
    } finally {
      owner.close()
    }
    await pending
    expect(history.older({ text: "draft", images: [] })?.text).toBe("first")
    expect(history.newer()?.text).toBe("draft")
    await writeFile(path, "malformed\n")
    await expect(history.record("not saved")).rejects.toThrow("malformed")
    expect(history.older({ text: "", images: [] })?.text).toBe("first")
    await writeFile(path, '{"version":1,"text":"first"}\n')
    await history.record("second")
    expect(history.older({ text: "", images: [] })?.text).toBe("second")
    expect(await readFile(path, "utf8")).toBe('{"version":1,"text":"first"}\n{"version":1,"text":"second"}\n')
  } finally {
    if (previous === undefined) delete process.env.XAL_HOME
    else process.env.XAL_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
