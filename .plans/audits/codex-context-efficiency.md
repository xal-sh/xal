# Codex context-efficiency final follow-up audit

## Verdict

**CHANGES NEEDED — FIX BEFORE PROCEEDING.**

The current source/evidence patch has no Medium-or-higher implementation or repository-standards defect. Production sizing and continuation pass for both session kinds; the three-run release evidence passes uncached input, continuation, median latency, and subagent p95. Phase 5, Phase 6, and the definition of done remain blocked by one locked live gate: primary p95 normal-request latency is 6,179.86 ms against a 5,442.51 ms baseline, a 13.55% regression and above the allowed 5% ceiling of 5,714.63 ms.

The review pinned base and `HEAD` to `fa6b2a9b7273add699a1877c35854e237d81cde7`. The working-tree input, excluding this required audit output, has stable patch ID `eee47d8b8657c4d27c379650699813d21bed32e8`, 5 modified files, 38 hunks, 187 additions, and 64 deletions. Every changed line and hunk was inspected on independent Standards and Spec axes.

## Standards

No Medium-or-higher Standards finding remains.

- The latest source reduction removes the unnecessary production summary-prompt rule and its test; no application runtime source is changed by this follow-up.
- The benchmark changes use typed unions, early failure, the shared request estimator, and current consumers. They add no unsafe wire cast, swallowed error, lint suppression, source-code comment, global mutable state, or plugin dependency.
- Continuation diagnostics expose only scenario labels, run numbers, and enumerated missing-check names. The committed evidence remains numeric and anonymous.
- `.plans/codex-context-efficiency.md:3`, `.plans/codex-context-efficiency.md:534-536`, and `.plans/codex-context-efficiency.md:546-547` match the current production fixture, release fixture, supplied profile diagnosis, and incomplete phase state.

Standards blockers: 0. Advisories reported: 0.

## Spec

### SP1 — High — primary p95 latency exceeds the locked 5% non-regression band

- Evidence: the paired primary baseline p95 is 5,442.51 ms at `scripts/fixtures/context-efficiency-live-baseline-v1.json:17`; the current release p95 is 6,179.86 ms at `scripts/fixtures/context-efficiency-live-release-v1.json:17`.
- Quantification: the regression is 737.35 ms, or 13.55%. The predeclared 5% ceiling is 5,714.63 ms, so the result exceeds the gate by 465.22 ms. The subagent p95 passes at 5,186.26 vs 6,744.88 ms.
- Violated spec: Outcome gate 4, Phase 3/5 live comparison, and the measured definition of done require paired latency not to regress beyond 5%. The harness enforces that exact ceiling at `scripts/context-efficiency-live.ts:904-906`.
- Supplied profiler evidence: the slowest primary ordinary request completed normally, has zero profile failure markers, and spent 5,629 ms waiting for the provider's first event. This attributes the observed outlier but does not waive the locked gate or make the frozen result green.
- Failure scenario: completing the plan would certify a latency non-regression that the latest like-for-like release fixture contradicts.
- Smallest valid disposition: keep Phases 5 and 6 incomplete. No source hardening task is evidenced by the numeric profile; a future authorized, like-for-like release validation may replace this result only after a justified reason to remeasure. Do not broaden the 5% band or rerun solely until favorable.
- Disposition: **blocked live gate; must pass before completion**.

No other Medium-or-higher Spec finding was found. Spec blockers: 1 High. Advisories reported: 0.

## Resolved findings and gates

- Paired uncached input: **resolved**. Primary is 241,686 vs 245,445 (-1.53%); subagent is 241,370 vs 248,985 (-3.06%); aggregate is 483,056 vs 494,430 (-2.30%).
- Median provider latency: **resolved**. Primary is 21,358.63 vs 24,028.51 ms; subagent is 20,784.20 vs 23,161.64 ms.
- Subagent p95 latency: **resolved** at 5,186.26 vs 6,744.88 ms (-23.11%).
- Continuation: **resolved** at 12/12 release scenarios and 2/2 production scenarios.
- Production size gates: **resolved**. Provider first post-compaction input is 4,261 primary and 3,657 subagent; runtime estimates are 5,970 and 5,103.
- Prior production-gate enforcement and compaction-removal telemetry findings remain resolved in the fixed base.

## Quantitative gate matrix

| Gate | Current evidence | Result |
| --- | --- | --- |
| Operational-tail violations | Candidate 90% replay: 0 | PASS |
| Replacement sensitivity estimate | median/p90/maximum 12,000; conservative 10k-summary case 17,500 | PASS (`<=32,000`) |
| Automatic compaction cadence | candidate 2 vs legacy 5; no workload increase | PASS |
| Production provider input | primary 4,261; subagent 3,657 | PASS (`<=35,000`) |
| Production runtime estimate | primary 5,970; subagent 5,103 | PASS (`<=32,000`) |
| Production continuation | primary 1/1; subagent 1/1 | PASS |
| Release continuation | 12/12 across paired and 64k automatic scenarios | PASS |
| Paired uncached input | primary -1.53%; subagent -3.06%; aggregate -2.30% | PASS |
| Paired median latency | primary 21,359 vs 24,029 ms; subagent 20,784 vs 23,162 ms | PASS |
| Paired subagent p95 | 5,186 vs 6,745 ms | PASS |
| Paired primary p95 | 6,180 vs 5,443 ms (+13.55%); allowed ceiling 5,715 ms | **FAIL** |
| Evidence privacy/provenance | anonymous labels, matching configuration fingerprint, paired fingerprints unchanged, automatic probe fingerprints versioned | PASS |
| Build/replay/CLI guardrails | supplied full checks green; audit replay, CLI smoke, and diff-check green | PASS |

## Changed-path audit

- `.plans/codex-context-efficiency.md`: Status, Known facts, Phase 5, and Phase 6 consistently distinguish green production/uncached/continuation/median/subagent-p95 gates from failed primary p95 and do not mark an incomplete phase green.
- `scripts/context-efficiency-live.ts`: automatic filler is separated from one final authoritative state notice, reserves hard-window space for the notice and continuation request, uses the public session path, and requires an observed automatic compaction. Missing continuation facts are classified without recording content; automatic workload fingerprints are versioned while paired workload identity remains comparable to baseline.
- `scripts/context-efficiency.test.ts`: every continuation field classification, authoritative notice shape, production gate category, and public manual/automatic path is exercised. The passing production fixture is not mutated to conceal a historical failure; the failure case is synthesized explicitly.
- Production and release fixtures: both round-trip through the numeric schema, retain anonymous labels and SHA-256 fingerprints, and contain no prompt, output, path, connection, session, call, or timestamp fields.

## Verification coverage

- Inventory: **5/5 files and 38/38 hunks inspected** on Standards and Spec axes; 187 additions and 64 deletions accounted for. This excludes the audit report from its own input.
- Focused audit tests: `bun test scripts/context-efficiency.test.ts` — **16 passed, 0 failed, 66 assertions**.
- Deterministic release replay passed: 2 automatic compactions vs legacy 5, 12,000 median first-post estimate, 0 operational-tail violations.
- CLI smoke and `git diff --check` passed.
- Supplied verification evidence records the full `bun checks:fix` run as green.
- No live or billable request was run during this audit. Sanitized fixtures and supplied numeric profiler findings were treated as frozen evidence.

## TL;DR

| Axis | High | Medium | Verdict |
| --- | ---: | ---: | --- |
| Standards | 0 | 0 | PASS |
| Spec | 1 | 0 | BLOCKED |
| Overall | 1 | 0 | **FIX BEFORE PROCEEDING** |
