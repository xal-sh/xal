import { expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ScriptedProvider, setupAgentSessionTests } from "../../../agent/session/test-support"
import * as catalog from "../../../providers/catalog"
import { listSkills, replaceSkills } from "../../../skills/registry"
import { parseTuiConfig } from "../config"
import { MessageHistory } from "../message-history"
import { Screen } from "../screen"
import { ResolvedShortcuts } from "../shortcuts"
import { AgentEventController } from "./agent-events"
import { AppEventController, InputQueue } from "./app-events"

test("refreshes open skill completion and the context window when runtime sources reload", async () => {
  const harness = await setupAgentSessionTests("tui-skill-reload-")
  const session = harness.createSession(new ScriptedProvider([]))
  const setup = await createTestRenderer({
    width: 100,
    height: 30,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  await setup.renderer.setupTerminal()
  const previous = listSkills()
  const screen = new Screen(
    setup.renderer,
    session,
    0,
    await MessageHistory.load(session.currentWorkingDirectory),
    parseTuiConfig({}),
    new ResolvedShortcuts({}),
    { submit: () => true, approve() {}, deny() {}, cancel() {}, answer() {}, reject() {} },
  )
  setup.renderer.root.add(screen.view)
  const agentEvents = new AgentEventController(screen, session)
  const controller = new AppEventController(screen, new InputQueue(() => true), undefined, () =>
    agentEvents.trackContextWindow(),
  )
  const contextWindow = spyOn(catalog, "contextWindow").mockResolvedValue(200_000)
  const displayedWindow = spyOn(screen.statusBar, "setContextWindow")
  try {
    agentEvents.trackContextWindow()
    await Bun.sleep(0)
    expect(displayedWindow).toHaveBeenLastCalledWith(200_000)
    contextWindow.mockResolvedValue(100_000)
    controller.handle({ type: "runtime_reload", source: "settings", outcome: "reloaded", message: "settings reloaded" })
    await Bun.sleep(0)
    expect(displayedWindow).toHaveBeenLastCalledWith(100_000)
    expect(session.currentModel).toBe("test-model")
    replaceSkills([])
    screen.composer.setValue("$new")
    expect(screen.palette.visible).toBe(false)
    replaceSkills([
      {
        name: "new-skill",
        description: "fresh guidance",
        body: "body",
        directory: "/skills",
        path: "/skills/SKILL.md",
        source: "user",
      },
    ])
    controller.handle({ type: "runtime_reload", source: "skills", outcome: "reloaded", message: "skills reloaded" })
    await setup.renderOnce()
    expect(screen.palette.visible).toBe(true)
    expect(screen.palette.handleKey("tab")).toBe(true)
    expect(screen.composer.draft().text).toBe("$new-skill ")
    screen.composer.setValue("$new")
    replaceSkills([])
    controller.handle({ type: "runtime_reload", source: "skills", outcome: "reloaded", message: "skills reloaded" })
    expect(screen.palette.visible).toBe(false)
  } finally {
    contextWindow.mockRestore()
    displayedWindow.mockRestore()
    const paletteChildren = screen.palette.view.getChildren()
    screen.palette.view.destroy()
    for (const child of paletteChildren) child.destroyRecursively()
    setup.renderer.destroy()
    await session.close()
    replaceSkills(previous)
    await harness.cleanup()
  }
})
