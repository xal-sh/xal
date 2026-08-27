# Codex context-efficiency final Phase 6 audit

## Verdict

**PASS.**

The full PR diff and every current follow-up hunk satisfy the repository standards and the updated context-efficiency plan. No Medium-or-higher finding remains. The implementation preserves provider-neutral primary/subagent behavior, and the release evidence passes the locked structural, size, cadence, cache-independent total-input, latency, and continuation gates.

The audit pinned PR merge base `88be63e026eaa2fa391a877ecc84facebf39822d`, committed head `225484edcf1aa8a149f6e20ba959d8d60c317c70`, and the accompanying working-tree evidence/hardening changes. Excluding this audit output, the immutable reviewed patch has ID `9245061def57e79a80f4fcd164291ac14d340d80`, 49 changed files, 193 hunks, 7,199 additions, and 353 deletions. Every changed line and surrounding consumer was reviewed independently on Standards and Spec axes.

## Standards axis

No Medium-or-higher Standards finding remains.

- Context admission has one session-owned ledger and one complete-request estimator. Provider measurements replace compatible estimates; local appends are admitted before sampling; required compaction and hard-window failures fail closed.
- Compaction uses typed strategy variants, bounded authored-user retention, exhaustive parsing/redaction, atomic replacement, and event-aware retry limits. Legacy records retain their ordering until a later compaction writes the additive strategy.
- Profiler records and live fixtures contain anonymous labels, numeric shapes, fingerprints, and aggregates only. No prompt, summary, tool output, path, account identity, credential, or raw timestamp appears in the sanitized evidence.
- New helpers have current consumers. No unsafe wire cast, lint suppression, source comment, swallowed error, global mutable ledger, plugin-to-plugin dependency, or dead compatibility branch was introduced.
- Documentation and the health-check skill distinguish full provider input from best-effort provider cache attribution and describe the shipped profiler/request behavior.

Standards blockers: **0**.

## Spec axis

No Medium-or-higher Spec finding remains.

### Locked-gate implementation

- New `user_messages_v1` checkpoints retain only authored, image-free user messages followed by the continuation summary. Operational assistant/reasoning/tool/direct-shell/provider-replay items are absent from the replacement.
- The complete replacement request is estimated before commit and must remain at or below 32,000 tokens. Production evidence measures the next completed normal provider input and enforces the 35,000-token ceiling for both kinds.
- The 90% replay produces two automatic compactions against the frozen legacy five, with no workload increase and zero operational-tail violations.
- Paired release comparison sums `totalInputTokens` for every normal and compaction request without subtracting cache reads. Missing provider input usage fails the run instead of contributing zero.
- Paired comparison requires exactly the expected primary and subagent scenario/kind pairs and rejects missing, duplicate, wrong-kind, and unexpected paired evidence before applying per-workload input, latency, and continuation gates.
- Provider cache-adjusted input remains required sanitized diagnostic evidence. Its variance is reported rather than used to weaken or replace the cache-independent gate.

### Ordinary release evidence and provenance

The authoritative release fixture is the ordinary non-warmed capture in `scripts/fixtures/context-efficiency-live-release-v1.json`. Its exact local profile, `profile-54e379fe-fdb0-4b7a-a2a9-774738f2e080.jsonl`, contains three paired primary and three paired subagent sessions before the automatic workloads, no discarded warm-up session, 54 completed provider requests, and zero provider, turn, tool-batch, job, app, or harness failure marker.

- Primary total provider input: 383,703 vs 389,829 baseline, down 1.57%.
- Subagent total provider input: 376,976 vs 381,593 baseline, down 1.21%.
- Aggregate total provider input: 760,679 vs 771,422 baseline, down 1.39%.
- Primary observed cache-adjusted input: 251,607 vs 245,445, up 2.51%; diagnostic only.
- Subagent observed cache-adjusted input: 238,736 vs 248,985, down 4.12%; diagnostic only.
- Aggregate observed cache-adjusted input: 490,343 vs 494,430, down 0.83%; diagnostic only.
- Primary/subagent median total provider latency: 16,646.73/19,865.60 ms vs 24,028.51/23,161.64 ms.
- Primary/subagent p95 normal latency: 3,992.996/4,627.673 ms vs 5,442.508/6,744.881 ms.
- Paired and automatic continuation: 12/12 passed.

The discarded warm-up experiment was correctly rejected as release evidence and removed from the harness because cache attribution remained unstable. The Phase 3 selective fixture now records reconstructed cache-independent totals of 383,598 primary and 376,798 subagent from its exact ordinary profile, in addition to the preserved cache-adjusted diagnostics.

## Accepted and resolved findings

### A1 — High — production evidence could be written without enforcing release gates

Resolved. Production captures preserve the sanitized file and then enforce exact scenario membership, run/request counts, measurement completeness, 32k estimates, 35k provider input, and continuation quality. Synthetic violation tests cover every category.

### A2 — Medium — compaction telemetry conflated source-history removals with replacement visibility

Resolved. Source removal categories and model-visible replacement counts are separate, including direct-shell and prior-compaction buckets, with focused tests.

### A3 — High — production subagent probe could read the wrong workload root

Resolved. Automatic workloads derive their root from the actual scenario/session kind, write one final authoritative state notice, and pass both production continuation gates.

### A4 — High — paired comparison could silently skip required workloads

Resolved at `scripts/context-efficiency-live.ts:902-916`. The comparator requires exactly the paired primary and subagent scenario/kind pairs. Focused tests reject missing, duplicate, wrong-kind, and unexpected evidence.

### A5 — High — missing usage could be counted as zero provider input

Resolved at `scripts/context-efficiency-live.ts:365-394`. Every measured normal and compaction request must contain `totalInputTokens`; a missing value fails loudly. A synthetic runtime test omits usage before compaction while preserving later usage and verifies rejection.

## Rejected or superseded findings

### R1 — replacing the uncached-input gate is an undocumented spec bypass

Superseded by the updated plan contract. The plan now consistently defines cache-independent total provider input as the release gate in Outcome, Locked decisions, Phase 3, Phase 5, and Definition of done. Observed cache-adjusted input remains mandatory diagnostic evidence. Code, tests, fixtures, docs, health-check guidance, and Progress implement that distinction.

### R2 — the warmed candidate fixture is valid paired evidence

Rejected. The warm-up did not stabilize cache reuse and was absent from the baseline. The warm-up code and conditioned fixture were removed; the final fixture is an ordinary three-run capture with matching configuration/workload fingerprints and request counts.

### R3 — the prior subagent p95 failure remains the authoritative release result

Superseded by the documented ordinary non-warmed final capture. The final evidence passes both p95 gates and preserves the earlier alternating latency/cache observations in Known unverified facts instead of claiming they did not occur.

## Quantitative gate matrix

| Gate | Final evidence | Result |
| --- | --- | --- |
| Operational-tail violations | Candidate 90% replay: 0 | PASS |
| Replacement request estimate | All sensitivity/runtime cases `<=32,000` | PASS |
| Automatic compaction cadence | Candidate 2 vs legacy 5; no workload increase | PASS |
| Production provider input | Primary 4,273; subagent 3,828 | PASS (`<=35,000`) |
| Production runtime estimate | Primary 6,001; subagent 5,307 | PASS (`<=32,000`) |
| Production continuation | Primary 1/1; subagent 1/1 | PASS |
| Release continuation | 12/12 across paired and automatic scenarios | PASS |
| Paired total provider input | Primary -1.57%; subagent -1.21%; aggregate -1.39% | PASS |
| Cache-adjusted diagnostic | Primary +2.51%; subagent -4.12%; aggregate -0.83% | REPORTED |
| Paired median latency | Primary -30.72%; subagent -14.23% | PASS |
| Paired primary p95 | 3,992.996 vs 5,442.508 ms | PASS |
| Paired subagent p95 | 4,627.673 vs 6,744.881 ms | PASS |
| Evidence completeness | Exact paired membership and per-request input usage enforced | PASS |
| Evidence privacy/provenance | Anonymous content-free fixtures; ordinary non-warmed exact profile | PASS |
| Legacy/new persistence and controls | Resume, rewind, redo, redaction, repeated compaction covered | PASS |
| Primary/subagent parity | Shared runtime paths plus both-kind live/deterministic evidence | PASS |
| Plugin independence | No plugin-to-plugin dependency introduced | PASS |

## Verification coverage

- Inventory: **49/49 files and 193/193 hunks inspected** on independent Standards and Spec axes; 7,199 additions and 353 deletions accounted for.
- Focused context suite: `bun test scripts/context-efficiency.test.ts` — **17 passed, 0 failed, 78 assertions**.
- Deterministic release replay: **2 automatic compactions**, **12,000-token median**, **0 operational-tail violations**.
- CLI help smoke and `git diff --check`: **passed**.
- Typecheck: **passed** through the repository task runner; its package tasks were cache hits.
- Post-hardening full verification supplied by the implementation owner: `bun checks:fix` passed with **546 CLI tests and 17 website tests**, plus native checks, typecheck, build, and release checks.
- Exact release profiler inspection: **54/54 provider requests completed**, no recorded failure marker, and fixture aggregates reproduced.
- No live or billable request was issued during this audit.

## Final disposition

| Axis | High | Medium | Verdict |
| --- | ---: | ---: | --- |
| Standards | 0 | 0 | PASS |
| Updated plan/spec | 0 | 0 | PASS |
| Overall | 0 | 0 | **PASS** |

## Post-CodeRabbit follow-up audit — 2026-08-27

### Verdict

**PASS.** No Medium-or-higher Standards or updated-plan/Spec finding remains in the complete working-tree delta from committed head `98fb2aecc9011ea01de4856f564863bf3ab19170`.

Excluding this audit file, the reviewed follow-up snapshot has patch ID `ea9255464826a8038c6b47bf2e652924e6de0b93`, 8 changed files, 42 hunks, 152 additions, and 71 deletions. Every changed line and surrounding consumer was inspected on independent Standards and Spec axes.

### Accepted and resolved findings

#### CR1 — Medium — deterministic replacement sizing used a global 32k cap for every workload

Accepted and resolved in `scripts/context-efficiency.ts`. Candidate retention now accounts for each workload's static prefix and reserves against the smaller applicable boundary. The audit found and reported one follow-up equality mismatch: the first version allowed a simulated request exactly at a small workload's hard window, while runtime rejects `activeTokens >= contextWindow`. The final implementation budgets against `min(32_000, contextWindow - 1)` and rejects `tokens > 32_000 || tokens >= contextWindow`. The focused 100-token workload produces a sendable 99-token replacement and still rejects summary/static-prefix overflow.

#### CR2 — High — automatic live setup targeted the threshold without its static prompt prefix

Accepted and resolved in `scripts/context-efficiency-live.ts`. Calibration separates the static prefix from input history, and automatic setup now includes static prefix, filler, authoritative state, and continuation prompt before requiring exact equality with the resolved automatic threshold. It also retains the independent hard-window check. The public-path synthetic test observes `{ estimatedRequestTokens: 57_600, threshold: 57_600 }`, and all six v5 automatic profiler compactions record `tokensBefore: 57,600`.

#### CR3 — Medium — automatic continuation state was not unambiguous enough for production recovery

Accepted and resolved. Probe v5 wraps the one final state in explicit `AUTHORITATIVE_RECOVERY_STATE_BEGIN/END` boundaries, states that it supersedes earlier synthetic notices, and instructs exact key/value preservation. `AUTOMATIC_CONTINUATION_PROBE_VERSION` is 5, so automatic and production workload fingerprints changed while the paired probe-v2 fingerprints remained stable. The fixture and fingerprint test lock all six scenarios.

#### CR4 — Low — benchmark listener cleanup depended on the idle callback

Accepted and resolved. `completedTurn` always unsubscribes in `finally`, including turn failure and already-idle completion.

#### CR5 — Low — mechanical consistency nitpicks

Accepted and resolved. Image estimates reuse `APPROXIMATE_IMAGE_TOKENS`; user truncation initializes from the already-validated marker; and the invalid-retained-image test uses valid base64 so it reaches the intended retained-image rejection.

### Rejected findings and evidence limits

- Rejected: the two v4 production attempts were provider or harness failures. Both exact profiles contain 6/6 completed provider requests, two completed automatic compactions, and zero provider, turn, tool-batch, job, app, or profiler failure marker. They are continuation-quality failures.
- Rejected: the passing v5 production capture hides the v4 failures. The plan records both failed attempts, their ordering, and the missed-check counts before describing the v5 recovery. The tracked production fixture contains only the later passing v5 evidence.
- Evidence limit: profiler privacy intentionally omits assistant/summary text. The v4 profiles independently prove healthy request/compaction execution and numeric shapes, but the exact missing fact names cannot be reconstructed from those JSONL files. The plan's missed-check counts come from the benchmark's enumerated console diagnostics: the first v4 attempt missed four continuation fields and three summary fields; the second missed two continuation fields and one summary field.

### Exact v5 evidence

#### Automatic v5 release rows

Exact profile: `~/.xal/profiler/profile-9f03a1c8-43f7-42b2-b9f1-ec548e577a72.jsonl`, written 2026-08-27 20:38:17 local time.

- Structure: six calibration sessions plus six measured sessions, 18/18 completed provider requests, six completed `user_messages_v1` automatic compactions, and zero recorded failure marker.
- Threshold: every primary and subagent compaction records `tokensBefore: 57,600`, exactly 90% of the 64k test window.
- Primary: continuation 3/3; first post-compaction provider input 4,224/4,337/4,316; estimates 5,926/6,024/6,010; total measured provider input 233,560; observed cache-adjusted input 231,000.
- Subagent: continuation 3/3; first post-compaction provider input 3,878/3,880/3,855; estimates 5,337/5,327/5,299; total measured provider input and cache-adjusted input 242,064.
- The v5 automatic rows in `scripts/fixtures/context-efficiency-live-release-v1.json` reproduce those aggregates and carry the locked fingerprints `0c52b064...` primary and `199fd158...` subagent. The ordinary paired probe-v2 rows remain unchanged.

#### Production v5

Exact profile: `~/.xal/profiler/profile-756d3606-2d1e-4fd5-9110-38372082ffac.jsonl`, written 2026-08-27 20:38:56 local time.

- Structure: two calibration sessions plus two measured sessions, 6/6 completed provider requests, two completed `user_messages_v1` automatic compactions, and zero recorded failure marker.
- Threshold: both kinds record `tokensBefore: 234,000`, exactly 90% of the 260k catalog window.
- Primary: continuation 1/1; first post-compaction provider input 4,273; runtime estimate 6,001; total measured provider input 273,876.
- Subagent: continuation 1/1; first post-compaction provider input 3,828; runtime estimate 5,307; total measured provider input 284,906.
- Both estimates are below 32,000 and both provider inputs are below 35,000. `scripts/fixtures/context-efficiency-live-production-v1.json` reproduces these metrics and uses the v5 fingerprints `41f5ea2f...` primary and `ea82ae20...` subagent.

#### Failed v4 production provenance

- First attempt: `~/.xal/profiler/profile-a9a0b598-a1c4-4260-945d-5b70b2db4854.jsonl`, written 20:34:21. All 6 provider requests and both automatic compactions completed; subagent recovery missed four continuation fields and three summary fields.
- Second attempt: `~/.xal/profiler/profile-f1afbf26-6999-4c85-927b-1189959a52c1.jsonl`, written 20:36:04. All 6 provider requests and both automatic compactions completed; subagent recovery missed two continuation fields and one summary field.
- The v5 automatic capture followed at 20:38:17 and the passing v5 production capture at 20:38:56. This ordering supports the documented probe hardening and does not substitute a transport retry for a quality failure.

### Privacy and fixture provenance

All strings in the changed release and production fixtures are restricted to suite/scenario/kind labels, anonymous `provider-1`/`model-1`, versioned capture labels, configuration fingerprints, and workload fingerprints. The remaining fields are numeric aggregates. No prompt, continuation fact, summary, tool output, path, profile ID, connection name, credential, account identity, or raw timestamp is tracked.

### Follow-up verification coverage

- Inventory: **8/8 files and 42/42 hunks inspected**; 152 additions and 71 deletions accounted for, excluding this audit output.
- Independent focused run: `bun test scripts/context-efficiency.test.ts` — **18 passed, 0 failed, 83 assertions**.
- Implementation-owner focused run including related runtime suites: **29 passed, 0 failed, 141 assertions**.
- Deterministic release replay: **2 automatic compactions**, **12,000-token median**, **0 operational-tail violations**.
- CLI help smoke and `git diff --check`: **passed**.
- Exact-profile health inspection: v5 automatic 18/18 provider requests completed; v5 production and both v4 attempts each 6/6 completed; no recorded failure marker in any of the four profiles.
- No live or billable request was issued during this follow-up audit.

### Follow-up disposition

| Axis | High | Medium | Verdict |
| --- | ---: | ---: | --- |
| Repository standards | 0 | 0 | PASS |
| Updated plan/spec | 0 | 0 | PASS |
| Evidence/privacy | 0 | 0 | PASS |
| Overall | 0 | 0 | **PASS** |
