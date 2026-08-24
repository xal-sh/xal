# Smart classifier-backed normal mode

> **Status:** reviewed
> **Review:** elevated · 2 passes · independent

## Summary

Replace normal mode's static handling of risky actions with a provider-backed safety classifier that decides whether a proposed tool call matches the user's request and stays within trusted boundaries. Keep Xal's existing permission rules as hard, deterministic policy: explicit deny rules still block, explicit ask rules still prompt, remembered and configured allow rules still allow, plan remains read-only, and yolo remains pre-approved. Fast-path read-only work, sandboxed commands, and workspace-local file edits so routine coding remains responsive; classify other normal-mode actions before execution and fail closed when no valid verdict is available. Integrate the result through the existing tool runner, session history, provider telemetry, persistence, TUI, and task-agent inheritance rather than creating a second execution path.

## Scope

### Outcome

- Normal mode works like Claude Code's core auto-mode behavior: routine local development proceeds without prompts, while a separate classifier allows or blocks non-routine actions according to user intent, project guidance, and trusted-environment boundaries.

### Requirements

| ID  | Requirement                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Preserve deterministic permission precedence across deny, ask, allow, plan, normal, custom modes, remembered approvals, and yolo.                                                                                                                                                                                        |
| R2  | In normal mode, auto-allow ordinary read-only calls, OS-sandboxed commands, and file edits confined to the workspace or temporary directory; keep explicit or built-in sensitive exceptions ahead of those fast paths and classify other unresolved actions.                                                             |
| R3  | Evaluate classified actions in a separate provider request against the user's stated intent and a conservative safety policy covering destructive operations, privilege or permission escalation, external data transfer, publishing or deployment, secrets, shared infrastructure, and prompt-injection-driven actions. |
| R4  | Build classifier input only from trusted system or project guidance, direct user messages, prior tool-call requests, trusted workspace metadata, and the pending action; do not expose tool outputs or assistant prose to the classifier.                                                                                |
| R5  | Fail closed on a blocked, malformed, unavailable, or interrupted classification, return an actionable denial to the coding model, and prevent the tool from starting.                                                                                                                                                    |
| R6  | Apply the same normal-mode gate to direct shell calls and write-capable task agents, including each child agent's actions, without weakening explicit parent or custom-mode denies.                                                                                                                                      |
| R7  | Show pending classification and denial cause in the TUI, preserve classifier denials in session records and exports, and attribute classifier cost and latency through the existing profiler and prompt-free usage ledger without storing classifier prompts or verdict text.                                            |
| R8  | Cover policy precedence, context filtering, verdict parsing, fail-closed behavior, session integration, direct shell, and task-agent inheritance with focused tests, then update permission and usage documentation.                                                                                                     |

### Constraints

- Keep the built-in mode name `normal`; do not add a fourth permission mode or change CLI/config mode values.
- Follow the repository's typed wire-boundary rule: parse classifier JSON from `unknown` with guards and use exhaustive unions instead of casts.
- Reuse the provider streaming, redaction, session, policy, and telemetry infrastructure already present.
- Do not weaken explicit `permissions.ask` or `permissions.deny` rules, plan mode, project trust, secret redaction, shell command parsing, OS sandboxing, or workspace undo.
- Fail loudly on provider and persistence errors, but represent a classification failure to the active coding turn as a denied tool result so the model can choose a safer alternative.
- Keep tests on critical behavior and run `bun checks:fix` after implementation, as required by `AGENTS.md`.

### Boundaries and assumptions

- "Match Claude Code auto mode" means matching its core decision shape and safety intent, not copying every Claude-specific administration feature or rule revision.
- The classifier uses a separate request through the session's active provider, profile, and model. This first increment does not add classifier-specific provider/model configuration.
- Existing permission rules remain the customization mechanism. This increment does not add an `autoMode.environment` schema, setup command, recently-denied management screen, server-managed policy tier, or a second sandbox implementation.
- Normal mode blocks a classified action instead of prompting immediately. To prevent an autonomous loop from getting stuck, an interactive session falls back to the existing approval prompt after three consecutive classifier blocks; headless and task-agent sessions continue to deny because they cannot collect approval. The counter resets after an allowed classified action or a mode/workspace change.
- A write-capable `task` call is classified before dispatch and each child action inherits normal-mode classification. A separate post-completion review of the child report is excluded because tool results are already treated as untrusted classifier input and the requested outcome does not require agent-team messaging parity.
- Earlier user boundaries may disappear after context compaction because classifier context intentionally excludes generated compaction summaries. Durable boundaries must use `permissions.ask` or `permissions.deny`, and the docs must state this limitation.

### Permission resolution order

| Order | Matching condition                                                          | Normal or normal-based custom mode                     | Plan or plan-based custom mode                         | Yolo or yolo-based custom mode             |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| 1     | Any global, active-mode, or inherited deny                                  | `deny`                                                 | `deny`                                                 | `deny`                                     |
| 2     | Non-read-only action while the mode base is read-only                       | not applicable                                         | `deny` even when an allow matches                      | not applicable                             |
| 3     | Any explicit global, active-mode, or plugin `ask`                           | `ask`, winning over every allow or remembered approval | `ask` for read-only actions                            | `allow` through yolo's deliberate ask skip |
| 4     | Any configured, project-remembered, or session approval                     | `allow`                                                | `allow` only for read-only actions                     | `allow`                                    |
| 5     | Built-in tool decision for a sensitive, external, or unsafe-to-parse action | `classify`                                             | `ask` when read-only, otherwise order 2 already denied | `allow`                                    |
| 6     | Built-in routine decision, read-only fast path, or OS-sandboxed fast path   | `allow`                                                | `allow` when read-only                                 | `allow`                                    |
| 7     | No earlier match                                                            | `classify`                                             | `allow` when read-only                                 | `allow`                                    |

Built-in risk registrations must therefore be distinguishable from explicit plugin/user asks. Ask wins over allow inside normal and plan so adding or remembering a broad approval cannot erase a user-authored checkpoint; yolo remains the explicit opt-out from prompts and classification. Every collision in this table is part of the Phase 1 test matrix.

## Current context

- `apps/cli/src/permissions/modes.ts` defines `normal` as the default with `skipAsk: false`; `plan` denies mutations and `yolo` converts asks to allows. Custom modes retain only `readOnly` and `skipAsk` from their base today, so classifier-backed inheritance needs an explicit mode property.
- `apps/cli/src/permissions/service.ts` currently returns only `allow`, `deny`, or `ask`, resolves registered and configured rules, and allows anything unmatched.
- `apps/cli/src/permissions/rules.ts` already tracks built-in contributions, user rules, custom-mode rules, remembered project approvals, and session approvals with last-match precedence after deny checks.
- `apps/cli/src/plugins/shell/plugin.ts` and `apps/cli/src/plugins/shell/policy.ts` turn risky or workspace-escaping shell commands into static asks; sandboxed commands bypass that dynamic gate.
- `apps/cli/src/plugins/files/plugin.ts` asks for external writes and sensitive reads while allowing temporary-directory writes; `apps/cli/src/plugins/files/permission.ts` supplies normalized path subjects.
- `apps/cli/src/agent/session/tool-runner.ts` is the single pre-execution seam for provider tool calls and direct shell calls. It evaluates policy before undo capture or tool execution and already returns denied outcomes to the model.
- `apps/cli/src/agent/session/session.ts` owns the active provider, profile, model, mode, working directory, system prompt, redacted history, session state, and task-agent host contract needed by classification.
- `apps/cli/src/agent/history.ts` distinguishes direct user messages, tool calls, tool results, generated compaction summaries, and direct-shell transcript entries, which permits a narrow classifier projection.
- `apps/cli/src/goals/evaluator.ts` and `apps/cli/src/providers/streamed-text.ts` are the nearest precedent for a tool-free provider request that uses the active provider, validates JSON, redacts text, profiles usage, and accepts an abort signal.
- `apps/cli/src/agent/task/tool.ts` already marks read-only task batches and forces write-capable delegation through policy; `apps/cli/src/agent/task/spawn.ts` makes write agents inherit the parent's permission mode.
- `apps/cli/src/agent/events.ts`, `apps/cli/src/sessions/records.ts`, `apps/cli/src/secrets/data.ts`, `apps/cli/src/profiler/profiler.ts`, `apps/cli/src/usage/recorder.ts`, and `apps/cli/src/plugins/tui/components/status-bar.ts` use typed exhaustive unions that must grow together for a new state, denial cause, and provider phase.
- Claude Code's current permission-mode documentation describes the reference behavior: explicit rules resolve first, read-only actions and workspace file edits skip classification, other actions go to a separate classifier, tool outputs are excluded from classifier context, and failures deny rather than execute. Sources: <https://code.claude.com/docs/en/permission-modes> and <https://code.claude.com/docs/en/auto-mode-config>.

## Execution

### Phase 1 - Make classification a first-class policy result

1. **Separate explicit prompts from classifier review** `[R1, R2]`
   - **Files / artifacts:** `apps/cli/src/permissions/types.ts`, `apps/cli/src/permissions/modes.ts`, `apps/cli/src/permissions/rules.ts`, `apps/cli/src/permissions/service.ts`, `apps/cli/src/permissions/service.test.ts`
   - **Action:** Extend the policy seam with a typed `classify` result while preserving the existing `allow`, `ask`, and `deny` meanings. Add an explicit classifier-backed property to `ModeDefinition` so custom modes retain whether their normal, plan, or yolo base classifies unresolved actions instead of inferring it from `readOnly` and `skipAsk`. Refactor registered built-in policy decisions and matched configured/remembered rules into the documented precedence table above rather than letting registered rules return before explicit policy is considered.
   - **Verify:** Extend `apps/cli/src/permissions/service.test.ts` with every row of the precedence table, including collisions between global/mode asks and allows, remembered approvals, built-in routine decisions, normal fallback, plan, yolo, and custom modes based on all three built-ins.

2. **Teach built-in tools which actions are routine** `[R1, R2]`
   - **Files / artifacts:** `apps/cli/src/plugins/files/plugin.ts`, `apps/cli/src/plugins/files/permission.ts`, `apps/cli/src/plugins/files/files.test.ts`, `apps/cli/src/plugins/shell/plugin.ts`, `apps/cli/src/plugins/shell/policy.ts`, `apps/cli/src/plugins/shell/plugin.test.ts`, `apps/cli/src/plugins/shell/interactive/register.test.ts`, `apps/cli/src/agent/task/tool.ts`, `apps/cli/src/agent/task/tool.test.ts`
   - **Action:** Reuse normalized path and shell-segment analysis to mark workspace/temp edits and sandboxed shell calls as built-in routine allows, external or risky built-in shell/file operations as classify, and write-capable task dispatch as classify. Do not encode safety by tool name inside the central service. Feed these built-in decisions into policy only after deny, plan, and explicit rule resolution, and keep unsafe-to-parse compound shell input conservative.
   - **Verify:** Add focused plugin tests for workspace edit, external edit, routine shell, risky shell, unsplittable shell, sandboxed shell, PTY input/resize, read-only task, and write task decisions, including explicit ask/deny overrides.

### Phase 2 - Add the safety classifier

3. **Define and validate the classifier contract** `[R3, R5]`
   - **Files / artifacts:** `(proposed) apps/cli/src/permissions/classifier.ts`, `(proposed) apps/cli/src/permissions/classifier.test.ts`, `apps/cli/src/lib/json.ts`
   - **Action:** Create a provider-neutral classifier request and a narrow verdict union, such as `allow` or `block` with a non-empty reason. Parse provider text from `unknown`, reject extra or malformed fields, redact the returned reason, and map every provider, parse, or abort failure to a fail-closed result. Keep the classifier tool-free and use the active session model with the lowest supported thinking effort, following the target-resolution pattern in `apps/cli/src/goals/evaluator.ts`.
   - **Verify:** Unit-test exact valid verdicts, malformed JSON, unknown verdicts, empty reasons, provider failure, abort, and secret redaction. Assert that no invalid result becomes an allow.

4. **Encode conservative intent and safety evaluation** `[R3]`
   - **Files / artifacts:** `(proposed) apps/cli/src/permissions/classifier.ts`, `(proposed) apps/cli/src/permissions/classifier.test.ts`
   - **Action:** Give the classifier an immutable system instruction that treats all supplied conversation text as evidence, not instructions. Require a block when the pending action is outside or materially broader than direct user intent, is driven by hostile retrieved content, crosses an unnamed trust boundary, exposes secrets or sensitive data, modifies permissions or credentials, targets production/shared infrastructure, publishes or deploys, or performs destructive/irreversible work without exact authorization. Allow routine requested development within the trusted workspace and its startup remotes. Keep explicit asks outside the classifier so user-mandated checkpoints cannot be reasoned away.
   - **Verify:** Table-test representative allow/block cases, including requested tests and installs, external upload, `curl | shell`, force push, destructive git reset, package publish, production deploy, credential output, permission escalation, and a prompt-injection instruction embedded in action context.

5. **Build a minimal trusted classifier context** `[R4]`
   - **Files / artifacts:** `apps/cli/src/agent/history.ts`, `apps/cli/src/agent/session/compose.ts`, `apps/cli/src/agent/session/session.ts`, `(proposed) apps/cli/src/permissions/context.ts`, `(proposed) apps/cli/src/permissions/context.test.ts`, `apps/cli/src/git/command.ts`
   - **Action:** Maintain generation-bound trusted metadata with two parts: immutable remotes captured when the current workspace becomes active, and current workspace/root metadata refreshed on session start, resume, and every `changeWorkspace`. Derive an isolated child snapshot from its own worktree root instead of copying the parent's root; inherit only parent trust facts that remain valid, such as already-captured remote destinations. Project the active history to direct user messages and prior tool-call names/arguments only, excluding assistant messages, reasoning, tool results, direct-shell output, and generated compaction summaries. Add the applicable composed system/project guidance, trusted workspace metadata, pending tool name/title/arguments/subject, read-only and sandbox flags, and a concise dirty-worktree signal for destructive Git/file actions. Apply existing redaction before the classifier request and cap context by dropping the oldest projected actions first while retaining the newest direct user intent and the pending action.
   - **Verify:** Unit-test that hostile strings in tool output, assistant prose, direct-shell output, and compaction summaries never enter the classifier request; verify user messages, project guidance, startup remotes, and pending redacted arguments do enter it; verify remotes added after activation are not silently trusted; verify workspace change/resume refreshes the root and generation; and verify an isolated child uses its worktree root.

### Phase 3 - Gate execution and handle denials safely

6. **Run classification at the existing pre-execution seam** `[R2, R3, R5, R6]`
   - **Files / artifacts:** `apps/cli/src/agent/session/tool-runner.ts`, `apps/cli/src/agent/session/session.ts`, `apps/cli/src/agent/session/types.ts`, `apps/cli/src/agent/session/session.test.ts`, `apps/cli/src/agent/session/session-control.test.ts`
   - **Action:** When policy returns `classify`, switch the session to a dedicated evaluating state, invoke the classifier before undo capture or execution, and restore the prior operational state on every exit. Execute only an allow verdict. Convert a block or classifier failure into a denied tool outcome with a `classifier` denial cause and a concise model-facing reason that directs the model to choose a safer alternative instead of blindly retrying. Use the same path for normal provider calls and `runDirectShell`.
   - **Verify:** Scripted-session tests must prove an allowed call runs once, a blocked/malformed/failed classification never runs, later tool calls can continue after a block, interruption cannot race into execution, direct shell uses the same gate, and explicit ask still opens the existing approval interaction without a classifier request.

7. **Bound repeated blocks and mode changes** `[R1, R5]`
   - **Files / artifacts:** `apps/cli/src/agent/session/session.ts`, `apps/cli/src/agent/session/tool-runner.ts`, `apps/cli/src/agent/session/session-control.test.ts`
   - **Action:** Track consecutive classifier blocks per session. Reset the count after a classified allow, workspace change, history movement, or permission-mode change. After three consecutive blocks, route the next classified action to the existing approval prompt only for an interactive primary session; after approval, reset the count. Continue denying in headless sessions and child agents, where approval is unavailable. Bind each pending verdict to the current mode/workspace generation and abort signal, then discard it if any generation changes before execution.
   - **Verify:** Test threshold behavior, reset behavior, headless denial, child-agent denial, approval resumption, interruption, workspace refresh, and stale mode/workspace generations.

8. **Keep task-agent behavior inside the same trust boundary** `[R1, R6]`
   - **Files / artifacts:** `apps/cli/src/agent/task/tool.ts`, `apps/cli/src/agent/task/spawn.ts`, `apps/cli/src/agent/task/task.test.ts`, `apps/cli/src/agent/task/activity.ts`
   - **Action:** Preserve the pre-dispatch classification for write-capable task batches. Initialize each child from its actual shared checkout or isolated worktree, inheriting the parent's still-valid remote trust facts but never its workspace root or generation. Read agents stay in plan mode; write agents inherit normal/custom/yolo behavior and inherited mode denies as today. Translate a child classifier block into ordinary denied activity so it can adjust and report, without attempting unavailable approval.
   - **Verify:** Extend task tests to prove a blocked write assignment does not spawn, an allowed assignment does, normal child actions are classified, explicit inherited denies win, read children remain read-only, and yolo children do not classify.

### Phase 4 - Surface and document the behavior

9. **Add typed observability without leaking classifier content** `[R5, R7]`
   - **Files / artifacts:** `apps/cli/src/agent/events.ts`, `apps/cli/src/sessions/records.ts`, `apps/cli/src/sessions/records.test.ts`, `apps/cli/src/sessions/export.ts`, `apps/cli/src/secrets/data.ts`, `apps/cli/src/profiler/profiler.ts`, `apps/cli/src/usage/recorder.ts`, `apps/cli/src/usage/recorder.test.ts`, `apps/cli/src/plugins/tui/components/status-bar.ts`, `apps/cli/src/plugins/tui/controllers/attention.ts`, `apps/cli/src/plugins/tui/controllers/agent-events.ts`, `apps/cli/src/plugins/tui/scrollback/render.ts`
   - **Action:** Add an `evaluating_permission` agent state, a `classifier` denial cause, and a `permission_classification` provider-usage phase through every exhaustive seam. Show a short status such as `reviewing action`; render blocked tools distinctly from user/policy/plan/hook denials; persist and export classifier blocks through the existing redacted tool outcome and denial cause. Attribute classifier provider/model/tokens/outcome/latency through the existing profiler and prompt-free usage record rather than adding a second session event that would duplicate every allowed tool call. Never store classifier prompts, arguments, verdict reasons, paths, profile IDs, or credentials in telemetry.
   - **Verify:** Run focused parser, redaction, export, profiler, usage, TUI status, and render tests. Inspect a recorded classifier usage line and a persisted blocked tool event to confirm each reads back in the documented shape and contains no prompt content; verify an allowed classification is observable in profiler/usage data without adding transcript noise.

10. **Update user-facing mode and cost documentation** `[R7, R8]`

- **Files / artifacts:** `docs/permissions.md`, `docs/integrations.md`, `docs/configs.md`, `apps/website/src/content/sections.ts`, `README.md`
- **Action:** Rewrite normal-mode documentation around classifier-backed execution, deterministic explicit-rule precedence, fast paths, fail-closed denials, repeated-block fallback, task-agent inheritance, context exclusions, compaction limitation, provider cost/latency, and yolo/plan differences. Update the website CLI summary that currently calls normal mode approval-gated. Keep configuration docs accurate by stating that existing allow/ask/deny and custom-mode rules are the only tuning surface in this increment and that no classifier-specific model setting exists.
- **Verify:** Run website content tests and search the docs/site for outdated claims that normal mode immediately prompts for every risky action or that usage phases include only turn, compaction, and goal evaluation.

## Validation

- **Automated policy and classifier tests:** `bun test apps/cli/src/permissions apps/cli/src/plugins/files apps/cli/src/plugins/shell` proves deterministic precedence, fast paths, context isolation, verdict parsing, and conservative fail-closed behavior.
- **Automated session and task tests:** `bun test apps/cli/src/agent/session apps/cli/src/agent/task` proves execution gating, direct shell, interruption, mode changes, repeated-block fallback, and child inheritance.
- **Automated persistence and UI tests:** `bun test apps/cli/src/sessions apps/cli/src/secrets apps/cli/src/usage apps/cli/src/plugins/tui` proves typed round trips, redaction, telemetry, and rendering.
- **Repository checks:** `bun checks:fix` applies required formatting/lint fixes and runs native checks, typecheck, lint, formatting, tests, builds, benchmarks, and release checks.
- **Manual interactive matrix:** In a disposable repository, run normal mode through a workspace edit, sandboxed test command, ordinary unsandboxed command, external network command, explicit `permissions.ask` command, classifier-blocked destructive command, three repeated blocks followed by approval, write task, plan mode, and yolo mode. Confirm only the intended calls execute and the TUI never appears idle while classification is pending.
- **Completion:** Normal mode executes routine local work without approval, independently allows or blocks every unresolved non-routine action before execution, honors explicit policy and mode boundaries, fails closed, applies to child agents, and exposes redacted usage and denial state consistently across interactive, headless, persisted, and exported flows.

## Risks and rollout

- **Risk:** A weak or compromised session model may incorrectly allow a dangerous action. **Mitigation:** Keep explicit deny/ask rules and static plan/project-trust/sandbox boundaries ahead of the classifier; exclude untrusted outputs; use conservative instructions and fail closed; retain yolo as the only mode that bypasses classification.
- **Risk:** Reclassifying currently allowed unsandboxed and MCP actions can add latency, token cost, and false positives. **Mitigation:** Fast-path reads, sandboxed commands, and local file edits; expose a dedicated usage phase; let narrow allow rules bypass classification; give blocked calls a reason and a bounded interactive fallback.
- **Risk:** Changing policy resolution can accidentally weaken custom modes or remembered approvals. **Mitigation:** Lock precedence in table-driven service tests before integrating provider calls and test custom modes based on normal, plan, and yolo.
- **Risk:** Parallel tool batches could classify and execute against stale mode or history. **Mitigation:** bind each request to the active abort signal and mode generation, discard stale verdicts, and do not prepare or execute any batch entry until its own classification allows it.
- **Risk:** Classifier context could become a prompt-injection channel or leak secrets to an extra provider request. **Mitigation:** reuse the active provider/profile, redact before transmission, omit outputs and assistant text, snapshot trusted metadata, cap context, and test absence rather than relying on prompt instructions alone.
- **Rollback:** Revert the classification result and integration while keeping the existing allow/ask/deny policy. No data migration is required; older readers already ignore unknown session events, but the implementation must keep session record compatibility tests green before release.

## Review outcome

- **Mode:** elevated; independent
- **Passes:** 2
- **Resolved:** Defined complete rule/custom-mode precedence, generation-bound workspace and worktree trust metadata, and proportional observability that avoids a duplicate persisted event. Targeted recheck found no blockers.
- **Scope cuts:** Claude-specific environment configuration, setup/inspection commands, recently-denied management UI, server-managed policy, separate classifier-model configuration, a second sandbox, and post-completion subagent report review.
- **Open blockers:** None.
