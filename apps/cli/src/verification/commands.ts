import { registerCommand } from "../commands/registry"
import { registerPrompt } from "../agent/prompt/registry"
import type { Command } from "../commands/types"
import { settings } from "../config/settings"
import { verificationDetails } from "./service"

const checksCommand: Command = {
  name: "checks",
  describe: "show verification evidence, or run a configured check · [name]",
  async run(args, ctx) {
    if (args.length > 1) throw new Error("usage: /checks [name]")
    if (ctx.session.currentState !== "idle") {
      ctx.print("cannot inspect or run checks while a turn is active")
      return
    }
    const name = args[0]
    if (name !== undefined) {
      const command = Object.entries(settings().verification.checks).find(([key]) => key === name)?.[1]
      if (!command) throw new Error(`unknown verification check: ${name}`)
      if (!ctx.session.send({ text: `!${command}`, images: [] }))
        ctx.print("cannot run a check while the session is busy")
      return
    }
    ctx.busy("Checking verification evidence")
    const checks = await ctx.session.verificationStatus().finally(() => ctx.busy())
    if (!checks) {
      ctx.print("No verification checks configured. Add named commands under verification.checks in config.json.")
      return
    }
    for (const line of verificationDetails(checks)) ctx.print(line)
  },
}

export function registerVerification(): void {
  registerCommand(checksCommand)
  registerPrompt({
    id: "verification",
    text() {
      const checks = Object.entries(settings().verification.checks)
      if (checks.length === 0) return ""
      return [
        "# Verification",
        "Configured checks produce execution receipts only when their exact command is run with bash in the foreground. They run in a fresh shell at the session workspace, not the persistent shell. Receipts describe observed execution, not proof of correctness; later workspace changes make them stale. Run checks when appropriate; they are not automatic completion gates.",
        ...checks.map(([name, command]) => `${name}: ${JSON.stringify(command)}`),
      ].join("\n")
    },
  })
}
