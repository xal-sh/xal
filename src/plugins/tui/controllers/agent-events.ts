import type { AgentSession } from "../../../agent/agent-session"
import type { AgentEvent } from "../../../agent/events"
import { historyMoveNotice } from "../../../agent/history"
import { describeError } from "../../../lib/error"
import { compactPath } from "../../../lib/path"
import { contextWindow } from "../../../providers/catalog"
import type { Screen } from "../screen"

export class AgentEventController {
  constructor(
    private readonly screen: Screen,
    private readonly session: AgentSession,
  ) {}

  trackContextWindow(): void {
    const provider = this.session.currentProvider
    const model = this.session.currentModel
    this.screen.statusBar.setContextWindow(undefined)
    void contextWindow(provider, model)
      .then((window) => {
        if (this.session.currentProvider !== provider || this.session.currentModel !== model) return
        this.screen.statusBar.setContextWindow(window)
      })
      .catch((error) => {
        this.screen.scrollback.append({ kind: "info", text: `model catalog: ${describeError(error)}` })
      })
  }

  handle(event: AgentEvent): void {
    const { scrollback, live, statusBar } = this.screen

    switch (event.type) {
      case "task_list_updated":
        this.screen.taskList.set(event.tasks)
        break
      case "plan_updated":
        if (event.plan.status === "draft" && !event.plan.feedback) {
          scrollback.append({ kind: "plan", path: compactPath(event.plan.path), text: event.plan.markdown })
          break
        }
        scrollback.append({
          kind: "info",
          text: `plan ${event.plan.status === "approved" ? "approved" : "saved for revision"} · ${compactPath(event.plan.path)}`,
        })
        break
      case "session_started":
        this.screen.startSession(event.title, event.cwd, event.model, event.thinking, event.mode)
        this.trackContextWindow()
        break
      case "session_replay_finished":
        break
      case "session_title_changed":
        this.screen.setSessionTitle(event.title)
        break
      case "workspace_changed":
        this.screen.setWorkingDirectory(event.cwd)
        scrollback.append({
          kind: "info",
          text: `workspace: ${compactPath(event.previous)} → ${compactPath(event.cwd)}`,
        })
        break
      case "state_changed":
        statusBar.setState(event.state)
        if (event.state !== "idle") break
        this.screen.dismissApproval()
        this.screen.dismissElicitation()
        scrollback.endStream()
        live.clear()
        this.screen.settleAgentActivity()
        break
      case "user_message":
        scrollback.append({ kind: "user", text: event.text, imageCount: event.imageCount, sentAt: event.sentAt })
        break
      case "conversation_rewound":
        scrollback.append({
          kind: "info",
          text: historyMoveNotice("undo", event.prompt, event.fileCount),
        })
        statusBar.resetUsage()
        break
      case "conversation_redone":
        scrollback.append({
          kind: "info",
          text: historyMoveNotice("redo", event.prompt, event.fileCount),
        })
        statusBar.resetUsage()
        break
      case "tool_call_updated":
        break
      case "hook_started":
        break
      case "hook_finished":
        scrollback.append({
          kind: "info",
          text: `hook: ${event.hook} · ${event.event} · ${event.action} · ${event.elapsedMs}ms`,
        })
        break
      case "queue_changed":
        this.screen.queued.set(event.entries)
        break
      case "queue_flushed":
        this.screen.composer.restore(event.inputs)
        break
      case "background_results":
        for (const result of event.results) {
          const label =
            result.kind === "agent"
              ? `background task ${result.id} · ${result.status}`
              : `background job ${result.id} · ${result.status}${result.exitCode === undefined ? "" : ` · exit ${result.exitCode}`}${result.signal === undefined ? "" : ` · ${result.signal}`}`
          scrollback.append({ kind: "info", text: label })
          scrollback.append({ kind: result.status === "completed" ? "text" : "error", text: result.output })
        }
        break
      case "text_delta":
        scrollback.appendStream("text", event.text)
        break
      case "reasoning_summary_delta":
        scrollback.appendStream("reasoning", event.text)
        break
      case "reasoning_delta":
        break
      case "assistant_message":
        if (!scrollback.endStream()) scrollback.append({ kind: "text", text: event.text })
        break
      case "reasoning_summary":
        if (!scrollback.endStream()) scrollback.append({ kind: "reasoning", text: event.text })
        break
      case "retry_scheduled":
        scrollback.append({
          kind: "info",
          text: `retrying in ${Math.ceil(event.delayMs / 1_000)}s · attempt ${event.attempt}/${event.maxAttempts} · ${event.message}`,
        })
        break
      case "mode_changed":
        statusBar.setMode(event.mode)
        break
      case "model_changed":
        statusBar.setModel(event.model)
        this.trackContextWindow()
        scrollback.append({ kind: "info", text: `model: ${event.model} · ${event.provider}` })
        break
      case "thinking_changed":
        statusBar.setThinking(event.thinking)
        break
      case "approval_requested":
        live.request(event.callId, event.tool, event.title, event.readOnly)
        this.screen.requestApproval(event.suggestion)
        break
      case "elicitation_requested":
        live.pause(event.callId)
        this.screen.requestElicitation(event.requestId, event.questions)
        break
      case "elicitation_resolved":
        this.screen.dismissElicitation()
        live.resume(event.callId)
        break
      case "tool_started":
        this.screen.dismissApproval()
        scrollback.endStream()
        live.start(event.callId, event.tool, event.title, event.readOnly)
        break
      case "tool_updated":
        live.update(event.callId, event.text)
        break
      case "shell_finished":
        this.screen.dismissApproval()
        scrollback.append({
          kind: "tool",
          tool: "bash",
          title: event.command,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          elapsed: live.finish(event.callId),
          expanded: true,
        })
        break
      case "tool_finished":
        this.screen.dismissApproval()
        this.screen.dismissElicitation()
        scrollback.append({
          kind: "tool",
          tool: event.tool,
          title: event.title,
          readOnly: event.readOnly,
          denial: event.denial,
          output: event.output,
          elapsed: live.finish(event.callId),
          expanded: false,
        })
        break
      case "compacted":
        scrollback.append({
          kind: "compaction",
          summary: event.summary,
          replaced: event.replaced,
          tokensBefore: event.tokensBefore,
        })
        statusBar.resetUsage()
        break
      case "turn_interrupted":
        statusBar.setTurnOutcome("interrupted")
        scrollback.append({ kind: "info", text: "Interrupted" })
        break
      case "turn_ended":
        statusBar.setTurnOutcome("completed")
        statusBar.setUsage(event.context)
        break
      case "turn_failed":
        statusBar.setTurnOutcome("failed")
        if (event.context) statusBar.setUsage(event.context)
        scrollback.append({ kind: "error", text: event.message })
        break
      case "error":
        scrollback.append({ kind: "error", text: event.message })
        break
    }
  }
}
