# Goals

Use goal automation when Xal should keep working until it can prove one measurable completion condition.

## Set and inspect a goal

`/goal <condition>` sets a condition for the current session and starts working on it immediately. After each successful agent turn, a separate tool-free evaluator checks the condition against evidence already surfaced in the conversation.

A `not_yet_met` verdict starts another turn with the evaluator reason as hidden guidance, `met` records the goal as achieved, and `impossible` stops with the reason. Conditions must be non-empty and contain at most 4,000 Unicode characters.

Use `/goal` without arguments to show the latest goal's condition, state, elapsed time, evaluated turns, cumulative goal token usage, evaluator model, and latest evaluator reason, including after it ends. `/goal clear` removes the active goal without interrupting a running agent turn. `stop`, `off`, `reset`, `none`, and `cancel` are exact aliases for `clear`.

## Evaluator model

The evaluator stays on the active provider. Configure a provider-specific model with:

```json
{
  "goal": {
    "evaluatorModels": {
      "openai-chatgpt": "<model-id>"
    }
  }
}
```

When no override is configured, the active session model evaluates the goal with the lowest thinking effort it supports. Evaluator requests have no tools and a 2,000-token output allowance, but their tokens are billed and included in goal usage. Before streaming, the complete estimated request plus output allowance must fit the selected evaluator model's known context window; oversized evidence fails evaluation and suspends continuation rather than being silently truncated. Returned tool calls and excessive text are rejected. Supported transports forward the output cap; ChatGPT subscription transport uses a local text safety limit and cancellation instead, which does not guarantee billed-token usage. The evaluator can judge only conversation evidence, so effective conditions name both a measurable end state and how the agent should prove it, such as `` `bun checks` exits successfully and `git status --short` is empty ``.

## Permissions and planning

Goal automation does not change permission mode. `normal`, `yolo`, custom rules, denials, and approval prompts continue to apply on every automatically started turn. `/goal` is independent of `/plan`: plan mode remains read-only proposal and review behavior, while a goal decides whether to start another turn. Auto-approval modes reduce permission prompts within a turn but do not provide goal completion evaluation.

See [Permissions and security](/docs/permissions) for mode behavior.

## Suspension and restoration

Evaluation waits while background agents, background processes, or undelivered results remain unsettled, and resumes once they settle. If eight consecutive `not_yet_met` turns make no tool calls, Xal suspends automatic continuation and keeps the condition. Interruptions, failed agent turns, evaluator failures, and undo or redo suspend it the same way. The next explicit user prompt re-arms a suspended goal.

Prompts submitted while the evaluator is running are queued and start the next turn.

A new session clears the goal. Forking carries the branch snapshot into the child session. Resuming a session whose latest goal state was active restores the condition, resets elapsed time, turns, usage, and evaluator guidance, then continues after replay finishes. Suspended, achieved, impossible, and cleared goals do not restart automatically.

## Headless execution

Headless execution accepts the set form and waits for the completion loop:

```bash
xal run "/goal CHANGELOG.md contains an entry for every merged PR and bun checks exits successfully"
```

Text and JSON output return after the goal reaches a terminal or suspended state. JSONL streams every `goal_updated` event and intermediate agent turn.
