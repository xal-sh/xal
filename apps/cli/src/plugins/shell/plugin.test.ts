import { expect, test } from "bun:test"
import { registerShell } from "./plugin"

test("registers shell tools and their supporting contributions through the plugin context", () => {
  const tools: string[] = []
  const prompts: string[] = []
  let disposers = 0
  let permissionRules = 0
  let policyRules = 0

  registerShell({
    registerTool(tool) {
      tools.push(tool.name)
    },
    registerToolSessionDisposer() {
      disposers += 1
    },
    registerPrompt(prompt) {
      prompts.push(prompt.id)
    },
    registerPermissionRules() {
      permissionRules += 1
    },
    registerPolicyRule() {
      policyRules += 1
    },
  })

  expect(tools).toEqual(["bash", "exec_command", "write_stdin"])
  expect(prompts).toEqual(["environment"])
  expect(disposers).toBe(2)
  expect(permissionRules).toBe(2)
  expect(policyRules).toBe(2)
})
