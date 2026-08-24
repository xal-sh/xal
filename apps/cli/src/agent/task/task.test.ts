import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createAgentJob, finishAgentJob, getJob, stopJob, suppressDelivery } from "../../background/jobs"
import { registerJobTools } from "../../background/register"
import { configureModes } from "../../permissions/modes"
import type { ModelCatalog, Provider, StreamRequest } from "../../providers/types"
import { bashTool } from "../../plugins/shell/bash/tool"
import { registerTool, unregisterTool } from "../../tools/registry"
import type { Tool } from "../../tools/types"
import type { AgentEvent, BackgroundResult } from "../events"
import { registerBasePrompt } from "../prompt/base"
import {
  completedRound,
  runSettledTurn,
  ScriptedProvider,
  setupAgentSessionTests,
  toolRound,
  type AgentSessionTestHarness,
  type ProviderRound,
} from "../session/test-support"
import { registerTaskAgents } from "./tool"

let harness: AgentSessionTestHarness

beforeAll(async () => {
  harness = await setupAgentSessionTests("sub-agent-test-")
  registerBasePrompt()
  registerJobTools()
  registerTaskAgents()
})

afterAll(async () => {
  await harness.cleanup()
})

function modelCatalog(): ModelCatalog {
  return {
    models: [{ id: "test-model", name: "Test model", inputModalities: ["text"] }],
    source: "runtime",
  }
}

test("keeps task mechanics in the tool contract and delegation policy in instructions", async () => {
  const provider = new ScriptedProvider([completedRound("Done.")])
  const session = harness.createSession(provider, { interactive: true })

  const outcome = await runSettledTurn(session, { text: "Inspect the project.", images: [] })
  const request = provider.requests[0]
  if (!request) throw new Error("provider request was not recorded")

  expect(outcome.status).toBe("completed")
  const task = request.tools.find((tool) => tool.name === "task")
  expect(task?.description).toContain("independent assignments")
  expect(task?.description).not.toContain("authorization")
  expect(request.instructions).toContain("explicitly request delegation")
  expect(request.instructions).toContain("Depth, research, or thoroughness alone is not authorization.")
  expect(request.instructions).not.toContain("Use the smallest useful batch")
})

test("wait_agent resumes on automatic agent delivery without collecting the result", async () => {
  const provider = new ScriptedProvider([
    toolRound("wait-agent", "wait_agent", { timeout_ms: 10_000 }),
    completedRound("Integrated the task-agent result."),
  ])
  const session = harness.createSession(provider, { interactive: true })
  const job = createAgentJob("wait-agent-test", {
    id: `wait_agent_${crypto.randomUUID()}`,
    ownerId: session.id,
    task: "Inspect the target.",
    timeoutMs: 60_000,
    maxTurns: 10,
    stop() {},
    send() {
      return false
    },
  })
  let finished = false
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "tool_started" || event.tool !== "wait_agent" || finished) return
    finished = true
    queueMicrotask(() => {
      finishAgentJob(job, { status: "completed", report: "event-driven task-agent report" }, "completed")
    })
  })
  const started = performance.now()

  try {
    const outcome = await runSettledTurn(session, { text: "Wait for the running task agent.", images: [] })
    const followUp = provider.requests[1]
    if (!followUp) throw new Error("provider follow-up request was not recorded")

    expect(outcome.status).toBe("completed")
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(
      followUp.input.some(
        (item) => item.type === "user_message" && item.text.includes("event-driven task-agent report"),
      ),
    ).toBe(true)
    expect(job.delivery).toBe("delivered")
  } finally {
    unsubscribe()
    if (!job.done) finishAgentJob(job, { status: "interrupted" }, "test cleanup")
    suppressDelivery(job)
  }
})

test("lets a child ask its parent, consume the answer, and finish in the same session", async () => {
  let parentSessionId = ""
  let parentRounds = 0
  let childRounds = 0
  let childSawFirstAnswer = false
  let childSawSecondAnswer = false
  let firstWaitOutput = ""
  let secondWaitOutput = ""
  const questionObserved = Promise.withResolvers<void>()
  const secondWaitStarted = Promise.withResolvers<void>()
  const provider: Provider = {
    id: `sub-agent-question-test-${crypto.randomUUID()}`,
    name: "Sub-agent question test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(_profileId: string, request: StreamRequest) {
      let response: ProviderRound
      if (request.sessionId === parentSessionId) {
        parentRounds += 1
        const transient = request.input.findLast(
          (item) => item.type === "user_message" && item.text.includes("Task agents are blocked"),
        )
        const dispatched = request.input.some((item) => item.type === "tool_call" && item.name === "task")
        const answerCount = request.input.filter((item) => item.type === "tool_call" && item.name === "job_send").length
        const waited = request.input.some((item) => item.type === "tool_call" && item.callId === "wait-question")
        const secondWaited = request.input.some(
          (item) => item.type === "tool_call" && item.callId === "wait-second-question",
        )
        const delivered = request.input.some(
          (item) => item.type === "user_message" && item.text.includes("question-child final report"),
        )
        if (!dispatched) {
          response = toolRound("dispatch-question", "task", {
            context: "Resolve one parent-only target decision.",
            tasks: [
              {
                name: "question_child",
                task: "Ask which target to use, then include the answer in the final report.",
                access: "read",
                isolation: "shared",
              },
            ],
          })
        } else if (transient && answerCount === 0) {
          const result = request.input.findLast(
            (item) => item.type === "tool_result" && item.callId === "wait-question",
          )
          firstWaitOutput = result?.type === "tool_result" ? result.output : ""
          response = toolRound("answer-question", "job_send", {
            id: "question_child",
            message: "Use target beta.",
          })
        } else if (transient) {
          const result = request.input.findLast(
            (item) => item.type === "tool_result" && item.callId === "wait-second-question",
          )
          secondWaitOutput = result?.type === "tool_result" ? result.output : ""
          response = toolRound("answer-second-question", "job_send", {
            id: "question_child",
            message: "Use format compact.",
          })
        } else if (delivered) {
          response = completedRound("Integrated the child report.")
        } else if (answerCount === 2) {
          response = completedRound("Both child questions were answered.")
        } else if (answerCount === 1 && !secondWaited) {
          response = toolRound("wait-second-question", "job_output", { id: "question_child", wait: 60 })
        } else if (!waited) {
          await questionObserved.promise
          response = toolRound("wait-question", "job_output", { id: "question_child", wait: 60 })
        } else {
          response = completedRound("The child question still needs an answer.")
        }
      } else {
        childRounds += 1
        const answers = request.input.filter(
          (item) => item.type === "tool_result" && item.output.includes("Parent answered:"),
        )
        if (answers.length === 0) {
          expect(request.tools.some((tool) => tool.name === "ask_parent")).toBe(true)
          response = toolRound("ask-target", "ask_parent", { question: "Which target should I use?" })
        } else if (answers.length === 1) {
          childSawFirstAnswer = answers[0]?.type === "tool_result" && answers[0].output.includes("Use target beta.")
          await secondWaitStarted.promise
          response = toolRound("ask-format", "ask_parent", { question: "Which format should I use?" })
        } else {
          childSawSecondAnswer = answers[1]?.type === "tool_result" && answers[1].output.includes("Use format compact.")
          response = completedRound("question-child final report: used target beta and compact format")
        }
      }
      yield* response(request)
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  const questions: Extract<AgentEvent, { type: "agent_questions" }>[] = []
  const deliveries: BackgroundResult[] = []
  const settled = Promise.withResolvers<void>()
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_questions") {
      questions.push(event)
      questionObserved.resolve()
    }
    if (event.type === "tool_started" && event.callId === "wait-second-question") secondWaitStarted.resolve()
    if (event.type === "background_results") deliveries.push(...event.results)
    if (event.type === "state_changed" && event.state === "idle" && deliveries.length > 0) settled.resolve()
  })

  try {
    await runSettledTurn(session, { text: "Dispatch the question task.", images: [] })
    await settled.promise

    expect(questions).toHaveLength(2)
    expect(questions[0]?.questions[0]?.jobId).toBe("question_child")
    expect(questions[0]?.questions[0]?.question).toBe("Which target should I use?")
    expect(questions[1]?.questions[0]?.question).toBe("Which format should I use?")
    expect(childSawFirstAnswer).toBe(true)
    expect(childSawSecondAnswer).toBe(true)
    expect(firstWaitOutput).toContain("[running]")
    expect(firstWaitOutput).not.toContain("Supervision checkpoint reached")
    expect(secondWaitOutput).toContain("[running]")
    expect(secondWaitOutput).not.toContain("Supervision checkpoint reached")
    expect(childRounds).toBe(3)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.output).toContain("question-child final report: used target beta and compact format")
    expect(parentRounds).toBeLessThanOrEqual(7)

    const recordMatch = /^Full task record: (.+)$/m.exec(deliveries[0]?.output ?? "")
    const recordPath = recordMatch?.[1]
    if (!recordPath) throw new Error("question task did not include its durable record path")
    const record = await readFile(recordPath, "utf8")
    expect(record).toContain("Which target should I use?")
    expect(record).toContain("Use target beta.")
    expect(record).toContain("Which format should I use?")
    expect(record).toContain("Use format compact.")
  } finally {
    unsubscribe()
    session.disposeToolResources()
  }
})

test("inherits deny rules and durably delivers a bounded task report", async () => {
  const deniedToolName = `denied_mutation_${crypto.randomUUID().replaceAll("-", "_")}`
  configureModes({ guarded: { base: "yolo", rules: { deny: [deniedToolName] } } })
  let mutations = 0
  const deniedTool: Tool = {
    name: deniedToolName,
    description: "Mutation blocked by the parent mode",
    parameters: { type: "object", additionalProperties: false },
    title: () => "blocked mutation",
    readOnly: () => false,
    async execute() {
      mutations += 1
      return { output: "mutated" }
    },
  }
  registerTool(deniedTool)

  const childReady = Promise.withResolvers<void>()
  const releaseChild = Promise.withResolvers<void>()
  const report = Array.from({ length: 1_200 }, (_, index) => `verified-result-${index}`).join("\n")
  let parentSessionId = ""
  let parentRound = 0
  let childRound = 0
  let deliveredInput = ""

  const provider: Provider = {
    id: `sub-agent-test-${crypto.randomUUID()}`,
    name: "Sub-agent test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(_profileId: string, request: StreamRequest) {
      let response: ProviderRound
      if (request.sessionId === parentSessionId) {
        parentRound += 1
        if (parentRound === 1) {
          response = toolRound("dispatch", "task", {
            context: "Verify policy inheritance and return a long report.",
            tasks: [
              {
                name: "policy_child",
                task: "Try the denied tool, then report what happened.",
                access: "write",
                isolation: "shared",
              },
            ],
          })
        } else if (parentRound === 2) {
          response = completedRound("Waiting for the task result.")
        } else if (parentRound === 3) {
          const input = request.input.findLast((item) => item.type === "user_message")
          deliveredInput = input?.type === "user_message" ? input.text : ""
          response = completedRound("Integrated the task result.")
        } else {
          throw new Error(`unexpected parent round ${parentRound}`)
        }
      } else {
        childRound += 1
        if (childRound === 1) {
          response = toolRound("denied", deniedToolName, {})
        } else if (childRound === 2) {
          childReady.resolve()
          await releaseChild.promise
          response = completedRound(report)
        } else {
          throw new Error(`unexpected child round ${childRound}`)
        }
      }
      yield* response(request)
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  session.setMode("guarded")
  let delivered: BackgroundResult | undefined
  let deliverySeen = false
  const settled = Promise.withResolvers<void>()
  const observe = (event: AgentEvent): void => {
    if (event.type === "background_results") {
      delivered = event.results[0]
      deliverySeen = true
    }
    if (event.type === "state_changed" && event.state === "idle" && deliverySeen) settled.resolve()
  }
  const unsubscribe = session.subscribe(observe)

  try {
    const initial = await runSettledTurn(session, { text: "Dispatch the policy check.", images: [] })
    expect(initial.status).toBe("completed")
    expect(initial.response).toBe("Waiting for the task result.")
    await childReady.promise
    releaseChild.resolve()
    await settled.promise

    if (!delivered) throw new Error("task result was not delivered")
    const recordMatch = /^Full task record: (.+)$/m.exec(delivered.output)
    const recordPath = recordMatch?.[1]
    if (!recordPath) throw new Error("task result did not include its durable record path")
    const record = await readFile(recordPath, "utf8")

    expect(mutations).toBe(0)
    expect(childRound).toBe(2)
    expect(parentRound).toBe(3)
    expect(delivered.status).toBe("completed")
    expect(delivered.output).toContain("[Result truncated.]")
    expect(delivered.output).toContain(recordPath)
    expect(record).toContain("Status: completed")
    expect(record).toContain(report)
    expect(deliveredInput).toContain("[Result truncated.]")
    expect(deliveredInput).toContain(recordPath)
  } finally {
    releaseChild.resolve()
    unsubscribe()
    session.disposeToolResources()
    unregisterTool(deniedTool)
    configureModes({})
  }
})

test("holds the task open across nested background Bash and delivers only the fresh report", async () => {
  registerTool(bashTool)
  let parentSessionId = ""
  let parentRound = 0
  let sawPrematureTurn = false
  let deliveredInput = ""

  const provider: Provider = {
    id: `sub-agent-async-test-${crypto.randomUUID()}`,
    name: "Sub-agent nested async test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(_profileId: string, request: StreamRequest) {
      let response: ProviderRound
      if (request.sessionId === parentSessionId) {
        parentRound += 1
        if (parentRound === 1) {
          response = toolRound("dispatch-async", "task", {
            context: "Run the build in the background and report its output.",
            tasks: [
              {
                name: "async_child",
                task: "Start the build in the background, then report its result.",
                access: "write",
                isolation: "shared",
              },
            ],
          })
        } else if (parentRound === 2) {
          response = completedRound("Waiting for the task result.")
        } else if (parentRound === 3) {
          const input = request.input.findLast((item) => item.type === "user_message")
          deliveredInput = input?.type === "user_message" ? input.text : ""
          response = completedRound("Integrated the task result.")
        } else {
          throw new Error(`unexpected parent round ${parentRound}`)
        }
      } else {
        const lastUser = request.input.findLast((item) => item.type === "user_message")
        const text = lastUser?.type === "user_message" ? lastUser.text : ""
        const started = request.input.some((item) => item.type === "tool_call" && item.name === "bash")
        if (!started) {
          response = toolRound("start-build", "bash", {
            command: "sleep 0.3 && echo finished-marker",
            background: true,
          })
        } else if (text.includes("finished-marker")) {
          response = completedRound("Final report: the background build produced finished-marker.")
        } else {
          sawPrematureTurn = true
          response = completedRound("Premature report before the build settled.")
        }
      }
      yield* response(request)
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  session.setMode("yolo")
  const deliveries: BackgroundResult[] = []
  const settled = Promise.withResolvers<void>()
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "background_results") deliveries.push(...event.results)
    if (event.type === "state_changed" && event.state === "idle" && deliveries.length > 0) settled.resolve()
  })

  try {
    const initial = await runSettledTurn(session, { text: "Dispatch the async build task.", images: [] })
    expect(initial.status).toBe("completed")
    expect(initial.response).toBe("Waiting for the task result.")
    await settled.promise

    expect(deliveries).toHaveLength(1)
    const delivered = deliveries[0]!
    expect(delivered.kind).toBe("agent")
    expect(delivered.status).toBe("completed")
    expect(delivered.output).toContain("Final report: the background build produced finished-marker.")
    expect(delivered.output).not.toContain("Premature report")
    expect(sawPrematureTurn).toBe(true)
    expect(deliveredInput).toContain("finished-marker")
    expect(parentRound).toBe(3)

    const recordMatch = /^Full task record: (.+)$/m.exec(delivered.output)
    const recordPath = recordMatch?.[1]
    if (!recordPath) throw new Error("task result did not include its durable record path")
    const record = await readFile(recordPath, "utf8")
    expect(record).toContain("background result")
    expect(record).toContain("Final report: the background build produced finished-marker.")
  } finally {
    unsubscribe()
    session.disposeToolResources()
    unregisterTool(bashTool)
  }
})

test("releases a child cancelled while ask_parent is pending without restoring the notice", async () => {
  const releaseChildQuestion = Promise.withResolvers<void>()
  const questionObserved = Promise.withResolvers<void>()
  let parentSessionId = ""
  let parentRound = 0
  let followupInput = ""
  const provider: Provider = {
    id: `sub-agent-cancel-test-${crypto.randomUUID()}`,
    name: "Sub-agent cancellation test provider",
    aliases: [],
    capabilities: { imageInput: false },
    async listModels() {
      return modelCatalog()
    },
    async defaultModel() {
      return "test-model"
    },
    async *stream(_profileId: string, request: StreamRequest) {
      if (request.sessionId === parentSessionId) {
        parentRound += 1
        if (parentRound >= 3) followupInput = JSON.stringify(request.input)
        if (parentRound === 1) {
          yield* toolRound("dispatch-cancel", "task", {
            context: "Ask one question and wait until cancelled.",
            tasks: [
              {
                name: "cancel_child",
                task: "Ask the parent which target to use, then wait for the answer.",
                access: "read",
                isolation: "shared",
              },
            ],
          })(request)
          return
        }
        yield* completedRound(parentRound === 2 ? "Waiting for the child question." : "Parent turn completed.")(request)
        return
      }

      await releaseChildQuestion.promise
      yield* toolRound("cancelled-question", "ask_parent", { question: "Which target should I use?" })(request)
    },
  }

  const session = harness.createSession(provider, { interactive: true })
  parentSessionId = session.id
  let deliveries = 0
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_questions") questionObserved.resolve()
    if (event.type === "background_results") deliveries += 1
  })

  try {
    const initial = await runSettledTurn(session, { text: "Dispatch a cancellable task.", images: [] })
    expect(initial.status).toBe("completed")
    expect(initial.response).toBe("Waiting for the child question.")
    releaseChildQuestion.resolve()
    await questionObserved.promise
    const job = getJob("cancel_child")
    if (!job || job.kind !== "agent") throw new Error("cancellable task job was not registered")
    expect(job.activity).toBe("Waiting for parent…")

    await stopJob(job, "model")
    await job.completion
    await runSettledTurn(session, { text: "Continue after cancellation.", images: [] })

    expect(job.outcome?.status).toBe("interrupted")
    expect(job.delivery).toBe("suppressed")
    expect(deliveries).toBe(0)
    expect(parentRound).toBe(3)
    expect(followupInput).not.toContain("Which target should I use?")
    expect(followupInput).not.toContain("Task agents are blocked")
    expect(session.currentState).toBe("idle")
  } finally {
    releaseChildQuestion.resolve()
    unsubscribe()
    session.disposeToolResources()
  }
})
