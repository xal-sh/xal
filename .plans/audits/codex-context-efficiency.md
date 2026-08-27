# Codex context-efficiency post-implementation audit

## Verdict

**BLOCKED — FIX BEFORE PROCEEDING.**

The implementation is structurally strong and the deterministic release replay is green, but Phase 5 and the definition of done are not green. Two required live gates failed in the frozen evidence: paired p95 latency regressed beyond the allowed 5% for both session kinds, and the single production-scale subagent continuation probe failed. The two Medium implementation defects found by this audit have been fixed and verified, but those fixes do not change the frozen live results. The plan must not be marked complete while the two High live findings remain open.

Audit input was pinned to base `88be63e026eaa2fa391a877ecc84facebf39822d` and head `8fa062bfb6a91915980c28cdb433cfe320aa07a4`. The committed diff contains 49 files, 193 hunks, 6,894 additions, and 353 deletions. The worktree had no staged or unstaged changes when the audit began. The follow-up verification also inspected the uncommitted five-file S3/S4 patch present in the shared worktree: 138 additions and 18 deletions.

## Spec

### S1 — High — paired p95 latency exceeds the locked non-regression gate

- Evidence: the frozen baseline is 5,442.51 ms primary and 6,744.88 ms subagent at `scripts/fixtures/context-efficiency-live-baseline-v1.json:17` and `scripts/fixtures/context-efficiency-live-baseline-v1.json:32`. The release result is 7,255.19 ms primary and 7,462.29 ms subagent at `scripts/fixtures/context-efficiency-live-release-v1.json:17` and `scripts/fixtures/context-efficiency-live-release-v1.json:32`.
- Impact: primary regressed 33.3% and subagent regressed 10.6%, both above the predeclared 5% noise band. This violates Outcome gate 4, Phase 3/5 live comparison requirements, and the measured definition of done.
- Disposition: **must-fix before completion**. Keep this gate failed unless a source-backed correction and a like-for-like authorized rerun pass; do not average it away or rerun solely until a favorable sample appears.

### S2 — High — production-scale subagent continuation quality failed

- Evidence: the primary production probe passed at `scripts/fixtures/context-efficiency-live-production-v1.json:18`, while the required subagent probe recorded `continuationPassRate: 0` at `scripts/fixtures/context-efficiency-live-production-v1.json:33`. The production first-post-compaction input and estimates otherwise passed at lines 36-37.
- Impact: one of the two required session kinds failed fact recovery after a real-window automatic compaction. This violates Outcome gate 4, Phase 5's both-kinds validation, primary/subagent parity, and the continuation definition of done.
- Disposition: **must-fix before completion**. Diagnose the failed continuation from numeric profiler evidence and use an authorized, like-for-like production rerun only after a justified correction. A single passing primary run does not satisfy subagent parity.

### S3 — Medium — FIXED AND VERIFIED — production release gates are enforced after evidence is written

- Fix evidence: `enforceProductionReleaseGates` at `scripts/context-efficiency-live.ts:698` requires exactly the primary and subagent production scenarios, exact run/request/measurement counts, every estimate at or below 32,000, median provider input at or below 35,000, and a continuation pass rate of one. `captureLive` writes the parsed sanitized result before invoking this gate at `scripts/context-efficiency-live.ts:792-798`, so a violation rejects the command without losing the failed evidence.
- Verification: `scripts/context-efficiency.test.ts:390-438` exercises a passing production result and rejects missing scenarios, wrong run and request counts, missing measurements, a 32,001 estimate, a 35,001 provider input, and the frozen fixture's zero subagent continuation result.
- Disposition: **resolved in the follow-up patch**. Focused tests pass. This command hardening correctly exposes S2; it does not turn the existing failed production evidence into a pass.

### S4 — Medium — FIXED AND VERIFIED — source removals and model-visible replacements are counted separately

- Fix evidence: `activeSourceHistory` at `apps/cli/src/agent/session/compaction.ts:194-197` selects the latest source checkpoint boundary without projecting record types. `runCompaction` now derives `replaced` from the active model-visible conversation and `removedTypes` from that source history at `apps/cli/src/agent/session/compaction.ts:237-240` and `apps/cli/src/agent/session/compaction.ts:311-324`; the atomic failure observation uses the same source categories at lines 355-358.
- Verification: the compaction test includes an earlier checkpoint and direct-shell record, asserts six model-visible replacements, and asserts source removal categories containing both `compaction` and `direct_shell`. The profiler shape test independently asserts both numeric buckets equal one.
- Disposition: **resolved in the follow-up patch**. The implementation preserves complete projected summary input while making categorical attribution factual; focused tests pass.

Open spec blockers: 2 High. Resolved audit findings: 2 Medium. Advisories reported: 0.

## Standards

No Medium-or-higher repository-standards defect was found in the pinned diff.

- The new wire parsers narrow `unknown` through JSON guards and reject unknown checkpoint strategies and invalid `user_messages_v1` retained items.
- Runtime seams use discriminated unions and exhaustive switches; no unsafe production wire-boundary cast or lint suppression was introduced.
- Provider round output and usage are committed through one synchronous session path, while no-usage output is estimated once.
- Errors are not swallowed: profiler writer failure is surfaced and stops profiling without mutating provider behavior; compaction fails closed and keeps history unchanged.
- Shared request sizing and UTF-8 truncation each have current consumers; legacy failure suppression and tail-retention code were removed.
- The change introduces no plugin-to-plugin import or dependency. OpenAI code consumes a core context-budget helper, which is the direction required by the plan.
- Configuration, provider, compaction, profiler, package-command, and health-check documentation was inspected against the runtime shapes.

Standards blockers: 0. Advisories reported: 0.

## Quantitative gate matrix

| Gate | Evidence | Result |
| --- | --- | --- |
| New operational-tail violations | Candidate 90% replay: 0 | PASS |
| Replacement estimate, observed sensitivity cases | median/p90/maximum: 12,000; conservative 10k-summary case: 17,500 | PASS (`<=32,000`) |
| Automatic compaction cadence | candidate 2 vs legacy 5, a 60% reduction; per workload 1/1/0 vs 2/2/1 | PASS |
| Production first post-compaction provider input | primary 4,112; subagent 3,908 | PASS (`<=35,000`) |
| Production runtime replacement estimate | primary 5,796; subagent 5,410 | PASS (`<=32,000`) |
| Paired uncached input | primary 239,147 vs 245,445; subagent 238,765 vs 248,985 | PASS |
| Paired median total provider latency | primary 21,609 vs 24,029 ms; subagent 22,150 vs 23,162 ms | PASS |
| Paired p95 normal latency | primary 7,255 vs 5,443 ms (+33.3%); subagent 7,462 vs 6,745 ms (+10.6%) | **FAIL** |
| Three-run release continuation | 12/12 across paired and 64k automatic scenarios | PASS |
| Production continuation | primary 1/1; subagent 0/1 | **FAIL** |
| Legacy session compatibility | parser/load/resume tests for legacy and `user_messages_v1`; version remains 2 | PASS |
| Plugin independence | no plugin-to-plugin dependency in diff | PASS |

## Runtime-path audit

- Ledger and double counting: `observe`-equivalent provider commits replace measurement with `totalInputTokens + outputTokens` and clear local deltas; no-usage items add estimates. Identity mismatch covers provider, profile, request model, conversation model, and cache key.
- Local admission paths: authored users, internal notices, queued prompts, background results, agent-question projections, output-contract corrections, tool results, and direct-shell history all enter the shared `pushItem`/complete-request path before the next normal sample. Transient question input is added directly to the exact request and therefore included in admission.
- Retry/interruption/atomicity: automatic compaction retries only the first retryable pre-event provider failure; received events, empty output, non-retryable failure, and interruption do not retry. Replacement occurs only after a non-empty summary and a successful complete-request budget check.
- Persistence/control: legacy ordering is unchanged; new records are additive version-2 records; strict parsing, redaction, load, resume, conversion, rewind, and redo have direct tests. A repeated new checkpoint summarizes the prior handoff once and writes a fresh checkpoint; an immediately repeated compaction returns `nothing`.
- Summary completeness: the summary request uses complete active semantic history, strips opaque replay, preserves assistant text/reasoning/tool calls/results, disables tools, omits schemas, and keeps original conversation-model cache identity while using the existing fast/low target policy.
- Thresholds: the shared helper applies the 90% ceiling and lower explicit limits; hard-window admission remains independent. ChatGPT runtime/cache metadata and ordinary/fast/large variants are covered.
- Privacy: the deterministic fixture contains only enumerated structural strings and numeric fields. Live reports contain anonymous provider/model labels, SHA-256 configuration/workload fingerprints, and numeric aggregates; no prompt, output, path, connection name, profile ID, call ID, or timestamp is present.

## Verification coverage

- Diff coverage: **49/49 files and 193/193 hunks inspected** on both repository-standards and plan/spec axes, including all added fixtures, docs, tests, runtime consumers, and deleted legacy paths.
- Targeted verification run by this audit: **118 tests passed, 0 failed** across profiler, request sizing, streamed text, ledger, compaction, session/control, records/store, redaction, conversation, tool output, ChatGPT metadata, catalog, and benchmark harness files.
- Follow-up S3/S4 verification: **26 tests passed, 0 failed, 163 assertions** across `scripts/context-efficiency.test.ts`, `apps/cli/src/agent/session/compaction.test.ts`, and `apps/cli/src/profiler/profiler.test.ts`.
- Deterministic release command passed: candidate automatic compactions 2, median post-compaction estimate 12,000, operational-tail violations 0.
- CLI smoke passed; `bun apps/cli/src/index.ts --help` produced runnable help output.
- `git diff --check` passed.
- Billable live requests were not rerun during this read-only audit. The committed sanitized baseline/selective/release/production reports were parsed and compared. Their failed gates remain failed, not unverified or inferred away.
- The audit did not rerun `bun checks:fix` because that command is mutating and this audit was explicitly read-only. The Phase 5 progress record says the full checks/build/release suite was green, while the targeted audit verification above independently covers the changed critical paths.

## Accepted and rejected concerns

Accepted hardening tasks are S1-S4 above. S3 and S4 are resolved and verified; S1 and S2 remain blocked on the frozen live evidence. No proposed concern was rejected after becoming a factual Medium-or-higher finding.

The following audited risk areas produced no Medium-or-higher finding and need no hardening task: ledger double counting; provider-output atomic commit; local append admission coverage; retry/interruption classification; legacy/new persistence and control flow; summary completeness and repeated compaction; 32k runtime/replay enforcement; 90%/explicit/hard thresholds; cache-key conversation-model handling; privacy allowlisting; primary/subagent shared runtime path; plugin dependency direction; dead helpers or failure-counter code; and documentation of shipped request behavior.

## TL;DR

| Axis | High | Medium | Verdict |
| --- | ---: | ---: | --- |
| Standards | 0 | 0 | PASS |
| Open spec findings | 2 | 0 | BLOCKED |
| Resolved spec findings | 0 | 2 | VERIFIED |
| Overall open findings | 2 | 0 | **FIX BEFORE PROCEEDING** |
