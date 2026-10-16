import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { registerBackgroundTask, removeBackgroundTask, type BackgroundProcessTask } from "../../../background/registry"
import { BackgroundTasks } from "./background-tasks"

test("background processes are labeled as shells and keep their job controls", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  let viewed: string | undefined
  let stopped = false
  const task: BackgroundProcessTask = {
    kind: "process",
    id: `bash-${crypto.randomUUID()}`,
    ownerId: "primary",
    title: "npm run dev",
    startedAt: Date.now(),
    cwd: process.cwd(),
    state: () => ({ running: true }),
    output: () => "server ready",
    stop: async () => {
      stopped = true
    },
  }
  const tasks = new BackgroundTasks(
    setup.renderer,
    {
      changed() {},
      released() {},
      viewJob(job) {
        viewed = job?.id
      },
      scrollViewer: () => false,
      error(message) {
        throw new Error(message)
      },
    },
    undefined,
    () => "primary",
  )
  setup.renderer.root.add(tasks.view)
  try {
    registerBackgroundTask(task)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain(`shell ${task.id} · npm run dev`)
    tasks.focus()
    tasks.handleKey("enter")
    expect(viewed).toBe(task.id)
    tasks.handleKey("x")
    expect(stopped).toBe(true)
  } finally {
    removeBackgroundTask(task.id)
    setup.renderer.destroy()
  }
})
