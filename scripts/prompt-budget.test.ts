import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("prompt-budget reserves stdout for a successful report after plugin shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "xal-prompt-budget-"))
  const plugin = join(home, "noisy")
  async function run(fail: boolean) {
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: [plugin], pluginConfig: { noisy: { fail } } }))
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "prompt-budget.ts"), "--headless"], {
      cwd: home,
      env: { ...process.env, XAL_HOME: home, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
    return { code, stdout, stderr }
  }
  try {
    await mkdir(plugin)
    await writeFile(
      join(plugin, "plugin.ts"),
      `export default {
      name: "noisy", register() {},
      bootstrap(ctx) { process.stdout.write("bootstrap message\\n"); if (ctx.config.fail) throw new Error("bootstrap refused") },
      shutdown() { console.log("shutdown message") }
    }`,
    )
    const success = await run(false)
    expect(success.code).toBe(0)
    expect(JSON.parse(success.stdout)).toMatchObject({
      interactive: false,
      tools: expect.arrayContaining([expect.objectContaining({ name: "activate_plugin" })]),
    })
    expect(success.stderr).toContain("bootstrap message")
    expect(success.stderr).toContain("shutdown message")
    const failure = await run(true)
    expect(failure.code).not.toBe(0)
    expect(failure.stdout).toBe("")
    expect(failure.stderr).toContain("bootstrap refused")
    expect(failure.stderr).toContain("shutdown message")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
