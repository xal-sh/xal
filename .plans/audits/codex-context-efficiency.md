# Codex context-efficiency fixed-replication audit

## Verdict

**CHANGES NEEDED — FIX BEFORE PROCEEDING.**

The current implementation/evidence patch has no Medium-or-higher source or repository-standards defect. The fixed release replication passes production sizing, continuation, uncached input, median latency, and primary p95. Phase 5, Phase 6, and the definition of done remain blocked by the subagent p95 live gate: 8,091.72 ms against a 6,744.88 ms baseline, a 19.97% regression and above the allowed 5% ceiling of 7,082.12 ms.

The audit pinned base `fa6b2a9b7273add699a1877c35854e237d81cde7`, committed head `a2f5d07456917bba69b2bcf39f40694d92f8e79f`, and the accompanying uncommitted release-fixture/plan changes. Excluding this required audit output, the immutable patch has ID `ab4079b927b15e8f04fd19a1c7a6f3a80e00a919`, 5 modified files, 38 hunks, 148 additions, and 64 deletions. Every changed line and hunk was inspected on independent Standards and Spec axes.

## Standards

No Medium-or-higher Standards finding was found.

- The benchmark code uses typed unions and shared estimators, fails loudly, and has current tests/consumers. It introduces no unsafe wire cast, swallowed error, lint suppression, source comment, global mutable state, or plugin dependency.
- Continuation diagnostics reveal only scenario names, run numbers, and enumerated missing checks. The release and production fixtures contain anonymous labels, SHA-256 fingerprints, and numeric aggregates only.
- The fixed replication preserved its outcome instead of repeating candidate runs until favorable. The time-matched legacy diagnostic is described as diagnosis rather than substituted for the frozen Phase 1 baseline.
- `.plans/codex-context-efficiency.md:3`, `.plans/codex-context-efficiency.md:534-537`, and `.plans/codex-context-efficiency.md:546-547` accurately distinguish passing gates, both observed candidate first-event outliers, the time-matched diagnostic, and the still-incomplete phases.

Standards blockers: 0. Advisories reported: 0.

## Spec

### SP1 — High — fixed replication fails the paired subagent p95 gate

- Evidence: the authoritative paired subagent baseline is 6,744.88 ms at `scripts/fixtures/context-efficiency-live-baseline-v1.json:32`; the accepted fixed replication is 8,091.72 ms at `scripts/fixtures/context-efficiency-live-release-v1.json:32`.
- Quantification: the increase is 1,346.84 ms, or 19.97%. The 5% ceiling is 7,082.12 ms, so the replication exceeds it by 1,009.60 ms. Primary p95 passes at 5,428.34 vs 5,442.51 ms.
- Violated spec: Outcome gate 4, Phase 3/5 live comparison, and the measured definition of done require paired latency not to regress beyond the predeclared 5% band. `compareBaseline` enforces this per workload at `scripts/context-efficiency-live.ts:904-906`.
- Candidate profile evidence: the subagent outlier is an initial 3,636-token normal request with no preceding compaction, no request/turn/tool/job/harness failure marker, a 7,594 ms wait for the first provider event, and normal completion at 8,092 ms.
- Diagnostic disposition: a time-matched run of the exact Phase 1 implementation with the same connection, model, probe-v2 workloads, and three-run count measured legacy primary/subagent p95 at 3,100.75/3,575.56 ms with no failures. This rules out a persistent provider-wide slowdown during diagnosis, but it neither replaces the frozen baseline nor identifies a candidate source path responsible for the alternating first-event outliers.
- Failure scenario: marking the plan complete would certify a subagent latency non-regression contradicted by the accepted fixed replication.
- Smallest valid disposition: keep Phases 5 and 6 incomplete. No source hardening task is supported by current numeric evidence; a future authorized validation can replace this result only after a new justified reason to measure. Do not broaden the 5% band, substitute the diagnostic, or run candidate repetitions until favorable.
- Disposition: **blocked live gate; must pass before completion**.

No other Medium-or-higher Spec finding was found. Spec blockers: 1 High. Advisories reported: 0.

## Resolved findings and gates

- Paired uncached input: **pass**. Primary is 239,216 vs 245,445 (-2.54%); subagent is 241,398 vs 248,985 (-3.05%); aggregate is 480,614 vs 494,430 (-2.79%).
- Median provider latency: **pass**. Primary is 20,238.15 vs 24,028.51 ms; subagent is 18,356.89 vs 23,161.64 ms.
- Primary p95 latency: **pass** at 5,428.34 vs 5,442.51 ms (-0.26%).
- Continuation: **pass** at 12/12 release scenarios and 2/2 production scenarios.
- Production size gates: **pass**. First post-compaction provider input is 4,261 primary and 3,657 subagent; runtime estimates are 5,970 and 5,103.
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
| Paired uncached input | primary -2.54%; subagent -3.05%; aggregate -2.79% | PASS |
| Paired median latency | primary 20,238 vs 24,029 ms; subagent 18,357 vs 23,162 ms | PASS |
| Paired primary p95 | 5,428 vs 5,443 ms | PASS |
| Paired subagent p95 | 8,092 vs 6,745 ms (+19.97%); allowed ceiling 7,082 ms | **FAIL** |
| Evidence privacy/provenance | paired fingerprints/config match baseline; automatic fingerprints versioned; fixtures content-free | PASS |
| Build/replay/CLI guardrails | supplied full checks green; audit replay, CLI smoke, and diff-check green | PASS |

## Changed-path audit

- `.plans/codex-context-efficiency.md`: Status, Known facts, Phase 5, and Phase 6 preserve both candidate observations and correctly treat the time-matched legacy run as diagnostic evidence, not a new baseline or proof of candidate innocence.
- `scripts/context-efficiency-live.ts`: automatic filler is separated from one final authoritative state notice, reserves hard-window space, uses the public session path, and requires observed automatic compaction. Missing facts are classified without recording content; paired workload fingerprints remain comparable while automatic workload fingerprints are versioned.
- `scripts/context-efficiency.test.ts`: all continuation checks, authoritative notice shape, production gate categories, and public manual/automatic paths are exercised. The passing production fixture is not modified to manufacture the negative continuation case.
- Production/release fixtures: both satisfy the strict numeric shape and privacy allowlist. The fixed release replication preserves exact paired workload fingerprints, configuration fingerprint, run counts, normal-request counts, and compaction counts from the baseline.

## Verification coverage

- Inventory: **5/5 files and 38/38 hunks inspected** on Standards and Spec axes; 148 additions and 64 deletions accounted for. This excludes the audit report from its own input.
- Focused audit tests: `bun test scripts/context-efficiency.test.ts` — **16 passed, 0 failed, 66 assertions**.
- Deterministic release replay passed: 2 automatic compactions vs legacy 5, 12,000 median first-post estimate, and 0 operational-tail violations.
- CLI smoke and `git diff --check` passed.
- Current branch/full-check evidence is green as supplied by the implementation owner.
- No live or billable request was run during this audit. Sanitized fixtures and supplied numeric profiler/diagnostic findings were treated as frozen evidence.

## TL;DR

| Axis | High | Medium | Verdict |
| --- | ---: | ---: | --- |
| Standards | 0 | 0 | PASS |
| Spec | 1 | 0 | BLOCKED |
| Overall | 1 | 0 | **FIX BEFORE PROCEEDING** |
