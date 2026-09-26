import { expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { ScriptedProvider, setupAgentSessionTests } from "../../../agent/session/test-support"
import {
  backgroundTasksChanged,
  listBackgroundTasks,
  registerBackgroundTask,
  removeBackgroundTask,
  type BackgroundProcessTask,
  type BackgroundTaskState,
} from "../../../background/registry"
import { parseTuiConfig } from "../config"
import { MessageHistory } from "../message-history"
import { Screen } from "../screen"
import { ResolvedShortcuts } from "../shortcuts"
import { AgentEventController, agentQuestionNotice } from "./agent-events"

const question = {
  requestId: "question-1",
  jobId: "child-1",
  question: "Which target should I use?",
}

test("renders live task-agent questions as actionable notices", () => {
  expect(agentQuestionNotice(question, false)).toEqual({
    kind: "notice",
    summary: "task agent child-1 is waiting for an answer",
    details: ["Which target should I use?", "Reply with job_send to child-1."],
  })
})

test("renders replayed task-agent questions as historical notices", () => {
  expect(agentQuestionNotice(question, true)).toEqual({
    kind: "notice",
    summary: "historical task-agent question from child-1",
    details: ["Which target should I use?", "This historical question is no longer actionable."],
  })
})

test("dismisses settled navigator rows only on a live accepted user message", async () => {
  const harness = await setupAgentSessionTests("tui-job-dismissal-")
  const session = harness.createSession(new ScriptedProvider([]))
  const setup = await createTestRenderer({
    width: 100,
    height: 30,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  await setup.renderer.setupTerminal()
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
  const controller = new AgentEventController(screen, session)
  const catalog = spyOn(controller, "trackContextWindow").mockImplementation(() => {})
  const prefix = `dismiss-${crypto.randomUUID()}`
  let state: BackgroundTaskState = { running: true }
  const finished = {
    kind: "process",
    id: `${prefix}-finished`,
    ownerId: session.id,
    title: "finished command",
    startedAt: 0,
    cwd: session.currentWorkingDirectory,
    state: (): BackgroundTaskState => ({ running: false, ok: true, detail: "exited with code 0" }),
    output: () => "saved output",
    stop: async () => {},
  } satisfies BackgroundProcessTask
  const active = { ...finished, id: `${prefix}-active`, state: () => state }
  const ids = (): string[] =>
    listBackgroundTasks()
      .filter((task) => task.id.startsWith(prefix))
      .map((task) => task.id)

  try {
    registerBackgroundTask(finished)
    registerBackgroundTask(active)
    controller.handle({ type: "state_changed", state: "idle" })
    controller.handle({ type: "state_changed", state: "streaming" })
    controller.handle({ type: "queue_changed", entries: [{ text: "next", imageCount: 0 }] })
    controller.handle({ type: "background_results", results: [] })
    expect(ids()).toEqual([finished.id, active.id])

    controller.handle(session.startEvent(true))
    controller.handle({ type: "user_message", text: "historical", imageCount: 0, sentAt: 1 })
    expect(ids()).toEqual([finished.id, active.id])
    controller.handle({ type: "session_replay_finished" })

    await setup.renderOnce()
    screen.tasks.focus()
    screen.tasks.handleKey("enter")
    expect(screen.jobViewer.visible).toBe(true)
    controller.handle({ type: "user_message", text: "next", imageCount: 0, sentAt: 2 })
    expect(ids()).toEqual([active.id])
    expect(screen.tasks.count).toBe(1)
    expect(screen.jobViewer.visible).toBe(false)

    state = { running: false, ok: false, detail: "stopped by the user" }
    backgroundTasksChanged("lifecycle")
    controller.handle({ type: "state_changed", state: "idle" })
    expect(ids()).toEqual([active.id])
    controller.handle({ type: "user_message", text: "continue", imageCount: 0, sentAt: 3 })
    expect(ids()).toEqual([])
    expect(screen.tasks.height).toBe(0)
    expect(screen.tasks.focused).toBe(false)
  } finally {
    catalog.mockRestore()
    removeBackgroundTask(finished.id)
    removeBackgroundTask(active.id)
    session.disposeAsyncDelivery()
    session.disposeToolResources()
    const paletteChildren = screen.palette.view.getChildren()
    screen.palette.view.destroy()
    for (const child of paletteChildren) child.destroyRecursively()
    setup.renderer.destroy()
    await harness.cleanup()
  }
})
