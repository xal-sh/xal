# Native Rust development

Phase 0 is not needed and is explicitly skipped and retired. Phases 1 and 2 are complete; the native headless provider/tool loop passes its deterministic gates. No baseline/spike prerequisite remains. The local roadmap and phase-completion rule are in `.plans/rust/status.md` (Git-ignored); this document, implementation, fixtures, and checks are tracked.

## Development executable

`xal-rust` is a side-by-side, headless development executable, **not the released application**. The installed `xal`, website, installer, and update channels are unchanged. It now includes OpenAI API Responses, a permission-enforced agent loop, and six workspace tools. Terminal UI, other providers, and an external plugin runtime remain later-phase work.

Build and run with Rust 1.92.0, without Bun or Node:

```sh
cargo run -p xal-rust -- --help
cargo run -p xal-rust -- --version
cargo run -p xal-rust -- config-check
cargo run -p xal-rust -- host-check
cargo run -p xal-rust -- storage-check crates/xal-services/tests/fixtures/session.jsonl
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p xal-rust --release --locked
```

- `config-check` validates the core settings schema, exact-root trust, credentials, paths, and redaction. `XAL_HOME` is trimmed using JavaScript whitespace rules; an empty value falls back to `~/.xal`. The nearest `.git` file/directory defines the project root; outside Git the working directory is used. Only exactly trusted project roots contribute `.xal/config.json`. Nested objects merge; arrays/scalars replace. Missing files are allowed; malformed/inaccessible files fail without printing their contents or secret-bearing paths. Plugin-specific settings remain the responsibility of their consuming phases. Configured external plugins fail explicitly rather than executing JavaScript or being silently ignored.
- `host-check` exercises a read-only session, tool, authoritative policy evaluation, prompt/hooks, typed decision, bounded provider stream, events, and plain UI contribution through two independent native plugins. The `diagnostic` provider formats a local report; it is not an AI model and makes no network request.
- `storage-check` reads and round-trips version-2 session envelopes and conversation/history items, preserving unknown fields, opaque provider replay data, historical events, and omitted versus explicit null fields. Event payloads are opaque at this layer: it does not validate domain event semantics, replay sessions, repair truncation, or claim P05 recovery. Malformed JSON, invalid item envelopes, and truncated records fail visibly.
- Help/version do not load configuration. The three diagnostic commands never create, migrate, or rewrite user data; their results go to stdout and errors to stderr. Clean diagnostic interruption exits 130 after owned cleanup; cleanup failures remain errors. `run` creates a new session journal and may write model caches, tool artifacts, and authorized workspace files; its format and signal contract is described below.

Use `XAL_HOME` pointing at a temporary directory and a synthetic workspace to try these checks. Tests create isolated homes and never access personal configuration or credentials.

## Native headless run (P02)

```sh
cargo run -p xal-rust -- run --help
cargo run -p xal-rust -- run --provider openai --connection Test --model gpt-4.1 --format json "Read the fixture and report its contents"
printf '%s' 'Read the fixture and report its contents' | cargo run -p xal-rust -- run --model gpt-4.1
cargo run -p xal-rust -- run --model gpt-4.1 --format json --output-schema schema.json "Return the requested object"
```

Use a dedicated test `XAL_HOME`, an API-key connection created with the existing `xal` connection workflow, and a disposable workspace for live experiments. `run` reads the existing credential/profile and configuration formats; it does not introduce an environment-variable API-key store, migrate credentials, or refresh OAuth. It selects explicit connection/provider/model overrides first, then saved preferences. Without a model override it uses the profile's version-1 OpenAI model cache or bounded `/models` discovery, with cache-recovery/save warnings on stderr. `XAL_OPENAI_BASE_URL` overrides the default `https://api.openai.com/v1` for controlled fixtures: HTTPS is required except for loopback HTTP; URL credentials, queries, fragments, and redirects are rejected. Do not send a real API key to an untrusted override.

- `run` accepts prompt words or, when absent, trimmed stdin. `--` ends option parsing. Modes are `normal`, `plan`, `yolo`, or configured custom names; deny rules remain authoritative. Plan sessions cannot modify files or run unsandboxed shell commands. Shell sandboxes are exposed only when supported on macOS.
- `--format text` prints the final answer, `json` prints one outcome object, and `jsonl` emits typed live events with the existing camelCase fields (`callId`, `readOnly`, usage counts). Diagnostics never go to JSONL stdout. Outcomes carry session/provider/model identity in JSON. Exit codes are 0 for completion, 1 for failure, 130 for SIGINT, and on Unix 143/129 for SIGTERM/SIGHUP after cancellation and owned cleanup.
- The loop composes the base/behavior/environment/permission prompts with registered prompt providers. It streams text, reasoning summaries, and tool calls; supports host-controlled input queues, steering, interruption, and bounded safe retries; and pairs interrupted calls with results before resuming. Identical tool/result loops are steered and then stopped. These are host APIs, not a new interactive stdin protocol.
- Registered tools are `read`, `write`, `edit`, `grep`, `glob`, and foreground `bash`. Tools run after argument hooks, schema/effect checks, and policy; read effects can overlap, writes are exclusive. Existing files require the session's current read hash before `write` or `edit(replace_all)`; ordinary exact edits retain their unique-match contract. File operations reject devices/FIFOs, validate opened handles, and check cancellation while scanning. Long read lines are bounded while their full content is hashed.
- Foreground shell cwd, exports, and functions persist within the session/sandbox. Concurrent read-sandbox calls can use isolated shells; sequential calls reuse state. Timeouts retain the shared shell's interrupt grace before a hard kill. Cancellation terminates and waits for the process tree. POSIX shell availability is required; wider platform behavior remains a P04 qualification obligation.
- Tool progress is incremental, redacted across chunk boundaries, bounded to 20 KiB, and delivered before completion. Final output is bounded to 2,000 lines and 50 KiB (20 KiB for shell); full redacted output is written to a secure `tool-<uuid>.txt` artifact under the session directory when needed. Unix artifacts/journals use `0600`, with newly created directories `0700`; storage failures are visible.
- Each run records a new version-2 JSONL session under the existing project-session path. Transient live events are not persisted; tool-argument updates follow their call items. The actual legacy reader is tested against both tool and compaction journals. This does not implement resume/fork, crash recovery, active-session handoff, or P05 ownership workflows.
- `--output-schema` requires a JSON-object schema and exposes the internal `submit_output` contract. It permits three correction attempts; ordinary text does not satisfy it. External schema references are disabled. Context admission accounts for the full request; ordinary summary compaction retains authored user messages and replaces history only after a complete, smaller summary has been journaled. Context overflow fails before an oversized provider request.

Not included in P02: ChatGPT/OAuth and other providers, image input, TypeSafe/provider-specific compaction and decision behavior (P03); hierarchical `AGENTS.md`, skills, memory, web/LSP/MCP and wider tools (P04); goals, background jobs, task agents, planning/interactive questions and durable continuation (P05); TUI (P06); external plugins (P07). Configured TypeSafe/external plugins and unsupported provider/goal/background requests receive explicit diagnostics. The native executable is not full product parity or a replacement for installed `xal`.

### Deterministic verification

No credentials are needed for these checks; all HTTP responses and homes/workspaces are synthetic:

```sh
cargo test -p xal-host --test agent --test permissions --locked
cargo test -p xal-rust --test headless --locked
cargo test -p xal-services -p xal-plugin-openai --locked
cargo build -p xal-rust --locked
bun scripts/rust/check-headless.ts
bun scripts/rust/check-boundaries.ts
```

The headless fixtures cover read/edit/verify, stdin/formats/usage/retry/redaction, denial without effects, malformed tool arguments, stale writes, partial streams, structured-output failure, oversized artifacts, context overflow, transactional summary compaction, repeated loops, signal/process-tree settlement, regular-file checks, and shell state across timeout/sandbox boundaries. Host tests cover hooks/effective arguments, read concurrency/write exclusion, queue/steer result pairing, sink-failure cleanup, uncooperative callbacks, and cancellation with saturated output (including redactor tails). Transport/schema tests cover chunked UTF-8/CRLF/multiline SSE, malformed/truncated/oversized records, model-bound reasoning replay, noncompleted Responses status, and external-reference refusal.

`scripts/rust/check-headless.ts [binary]` runs the real executable against loopback fixtures, consumes eval-style JSONL fields, and loads its journals with the unchanged legacy session reader. It also checks that loading does not repair/rewrite the journals. Bun is used only by the compatibility harness, not by `xal-rust`. The existing eight-target workflow now includes both new plugin crates and the release-binary compatibility smoke; remote execution is not claimed.

### P02 verification — complete

Implementation/review base: `c8939ba9d2fec63fcd42b9f502cbe37eba1c44b0`. Local environment: macOS 27 arm64, Rust 1.92.0, Bun 1.4.0. All P02 work and deterministic exit gates pass; this is not full product or platform qualification.

- **105 workspace Rust tests pass**, including 14 headless integration tests. Workspace Clippy passes with `-D warnings`.
- **`bun checks:fix` passes** with the environment-only legacy-addon workaround below: native checks/benchmark, type checking, lint/format, 668 CLI tests, 17 website tests, website build, and release packaging check. The three source eval-report tests also pass; ignored reference copies discovered by the broader script glob are not additional source tests.
- **Read/edit/verify and all critical failure gates pass:** denial without effects, stale write, partial/failing stream, interrupted tool/process tree, malformed arguments, oversized output, schema failure, and context overflow. Transactional summary compaction, queued/steered result pairing, output ordering, bounded backpressure cancellation, and nonregular-file refusal also pass.
- **Eval JSONL and persisted sessions pass the real legacy consumers.** The compatibility smoke passes with both development and release binaries and in an isolated archive of the unchanged CLI source/package metadata without `node_modules` or an addon. Synthetic homes/workspaces are removed afterward; personal credentials are never used.
- **All eight release executables build.** The macOS arm64 release passes the compatibility smoke and diagnostic commands; both Mach-O dependency lists contain only system libraries. Plugin/headless boundaries, the eight-target workflow YAML, and all 14 roadmap documents' links pass.
- **Independent review is closed with zero remaining blockers on Standards and Spec.** The 65-file/100-hunk tool/extraction review and 22-file/26-hunk runtime review cover all 86 changed paths, with one overlapping test file. Follow-up reviews cover all safety fixes, including wrapper operands and command-lookup handling. Runtime closure patch: `76a68aa29b3934c0a0856538f0abd3229ed77a5eae367bb42e243a6acc675415`; final two-file/882-line permission closure: `2ab82519bb91ff3c0069c4b9bdd7d2afda0c236c717e9415f6b6792162e15a1e`. Final evidence-only prose was checked against the observed results.

Local raw logs are under `target/p02-evidence/`, including `checks-fix-final.log`, `eight-builds-final.log`, `clean-consumer-final.log`, and the failing-before/passing-after permission regressions. Tracked tests, commands, and this document are the durable evidence.

A controlled live OpenAI test credential was not supplied, so live authentication/generation remains **unverified**; personal credentials were not inspected to obtain one. Remote CI, the other seven target runtimes, Windows ACL execution, OS minimums, and full platform qualification also remain unverified. Successful cross-builds alone do not close those gates.

### Headless release sizes

These are as-built executable bytes with the existing release profile (`panic = "unwind"`) and no post-build strip step. They are milestone measurements, not approved full-feature budgets. The P01 table later in this document is historical.

| Target                       |      Bytes | Build | Target execution                |
| ---------------------------- | ---------: | ----- | ------------------------------- |
| `aarch64-apple-darwin`       | 12,393,856 | Pass  | Tests and release smoke pass    |
| `x86_64-apple-darwin`        | 13,737,528 | Pass  | Unverified; Rosetta unavailable |
| `x86_64-unknown-linux-gnu`   | 12,489,360 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-gnu`  | 10,559,568 | Pass  | Unverified; runner unavailable  |
| `x86_64-unknown-linux-musl`  | 11,935,968 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-musl` | 10,072,344 | Pass  | Unverified; runner unavailable  |
| `x86_64-pc-windows-msvc`     | 11,337,728 | Pass  | Unverified; runner unavailable  |
| `aarch64-pc-windows-msvc`    |  9,675,776 | Pass  | Unverified; runner unavailable  |

Build commands and deployment targets are the same as the foundation commands below: locked release builds, cargo-zigbuild 0.23.4 with Zig 0.15.2 for Linux, cargo-xwin 0.23.1 with the MSVC SDK/CRT and Rust's linker for Windows. Missing locked target dependencies were fetched with `cargo fetch --locked --target <target>` before offline builds; an initial missing `openssl-probe` cache entry was resolved, not treated as a platform failure.

The expanded Windows dependency graph also needs NASM and an LLVM librarian when cross-building from macOS. Local verification used NASM 3.02 and Rust's `llvm-tools-preview` component, exposing its `llvm-ar` under the `llvm-lib` invocation name:

```sh
rustup component add llvm-tools-preview
brew install nasm
mkdir -p target/windows-tools
ln -sf "$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/llvm-ar" target/windows-tools/llvm-lib
export PATH="$PWD/target/windows-tools:$PATH"
```

Then use the cargo-xwin environment/linker command below. These are local build prerequisites, not additional installed runtime components or a release-policy change.

## Boundaries and ownership

| Crate                    | Responsibility                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xal-rust`               | Executable composition root, diagnostics, and headless `run` argument/output/signal handling.                                                                                                                                                                              |
| `xal-host`               | Typed session/event, command, tool, provider/decision, hook, prompt, policy, and UI contracts. Per-host staged registries, asynchronous bootstrap/readiness, cancellation, bounded queues, owned subscriptions/tasks/disposers, failure reporting, reverse shutdown.       |
| `xal-services`           | Config/trust/path resolution, validated settings, secure atomic storage, credentials/immutable profile IDs, session-envelope codecs, shared UTF-16 and streaming/JSON redaction, file/search/process/shell algorithms, JSON Schema validation, bounded HTTP/SSE transport. |
| `xal-plugin-inspect`     | Read-only config/storage commands and inspection tool/policy.                                                                                                                                                                                                              |
| `xal-plugin-diagnostics` | Local report provider/decision, prompt/hook, and plain renderer.                                                                                                                                                                                                           |
| `xal-plugin-openai`      | OpenAI API-key Responses transport, replay, usage, model discovery/cache selection.                                                                                                                                                                                        |
| `xal-plugin-workspace`   | Independent files, search, and foreground-shell registrations using host policy and shared services.                                                                                                                                                                       |
| `xal-native`             | Legacy N-API adapters plus services not yet consumed by the rewrite. File/search/process/shell/output-contract/redaction adapters call extracted services; addon cache hashing includes shared sources.                                                                    |

Plugins depend on host contracts/services, never sibling implementations. `bun scripts/rust/check-boundaries.ts` checks the workspace graph and the executable's normal dependency tree. No N-API, JS scheduling, addon loading, terminal, or Wasm dependency exists in the native executable. Bun runs this repository check, not the executable.

Registration is synchronous and staged; bootstrap and callbacks may be asynchronous. Contributions become callable only after owner readiness. Duplicate identities/capabilities, failures, panics, and cancellation discard the failed owner's complete staged contributions, close its subscriptions, and clean up owned resources. Healthy owners remain available when another owner fails. Provider queues backpressure; event queue overflow or a closed subscription is a visible error, never a silent drop. Cancellation is hierarchical across host, owner, and session operations; callback-local cancellation cannot report success or cancel sibling calls. Hooks run in owner order and then registration order, preserving replacement semantics.

Tool invocation runs before-tool hooks before policy checks; any policy denial wins over allows, requests for approval cannot be bypassed by allows, read-only sessions reject modifying tools, and no explicit allow means approval is required. The native headless path also applies normal/plan/yolo/custom and remembered rules; yolo skips asks but never overrides denials. Unresolved shell expansions and wrapper options fail closed when applicable shell-deny rules exist, including sandboxed requests. Command candidates and lookup exemptions use the same operand-aware wrapper parser. Approval-required headless actions are refused without effects.

Shutdown cancels owners, visits plugins in reverse registration order, joins/aborts owned tasks, and disposes resources in reverse ownership order. Callback panics and cleanup errors remain visible without skipping remaining cleanup. Async shutdown/disposers have a five-second deadline per callback. Await lifecycle futures to settlement; request cancellation through the token rather than dropping startup/rollback or shutdown futures. Call `shutdown().await` explicitly; dropping an active host cancels/aborts tasks and diagnoses the missing shutdown, but cannot run arbitrary asynchronous disposers. The executable cancels and awaits interrupted startup/rollback before shutting down, and explicitly shuts down on success and failure too. Native callbacks remain trusted/cooperative code; preemptive isolation belongs to the external runtime phase.

## Persistence foundations

The diagnostic commands only read. The following foundations also support `run`; verification uses synthetic fixtures:

- Settings patches validate the merged effective configuration before atomically replacing the user file. Unknown raw fields are preserved. Trusted project overrides are not copied into the user file. The explicit TypeSafe setting update removes the same obsolete user fields as the legacy writer. Trust grants/revocations preserve exact path-string identity.
- Secure writes use an exclusive same-directory temporary file, flush data, then atomically rename. Unix files are mode `0600` and directory metadata is synced. Windows new files have a protected owner/System DACL. Temporary cleanup failures are reported. Readers/writers reject symlink/non-regular final paths; JSON/text files are bounded to 64 MiB. Windows ACL execution and filesystem semantics require real-runner verification, not just cross-compilation.
- Credential wire format remains `{"profiles":{"id":{"name","provider","credential"}}}`. API keys and OAuth access/refresh/expiry/account identity round-trip; IDs stay unchanged by rename/refresh, and new IDs are random UUIDv4. Names use JavaScript trim, an 80-UTF-16-unit limit, control-character rejection, and case-insensitive uniqueness. The legacy empty-directory `credentials.json.lock` protocol is retained (25 ms poll, 10 s wait/stale threshold); no incompatible lock-file scheme is introduced. Mutations lock before reading, reject malformed stores/provider mismatches, and refresh uses compare-and-swap rather than overwriting newer credentials. Lock contention cancellation does not remove another writer's lock. Profile presentation sorting is a UI concern, not a storage guarantee.
- The extracted redactor preserves UTF-16 code-unit matching, overlap priority, marker collision handling, and lone-surrogate behavior of the legacy matcher. Native text streams use an immutable secret snapshot, hold prefixes across chunks, and flush at end; JSON keys and values are redacted. The inspection report includes both configured/environment secrets and stored credential secrets. Secret changes during live provider sessions remain the consuming provider phase's responsibility.
- Session-envelope fixtures preserve persisted objects without automatic migration. Full domain-event validation, mixed-process active-session ownership/recovery, usage/cache/background formats, and live continuation belong to their consuming phases. No reader success is labeled full persistent-data parity.

## P01 verification — historical foundation evidence

Implementation/review base: `aec68492b63e72a8dfe2586ee8667667616a2689`. Local environment: macOS 27 arm64, Rust 1.92.0, Bun 1.4.0.

Verified locally:

- 73 workspace Rust tests pass: 30 foundation tests and 43 retained native tests. Workspace Clippy passes with `-D warnings`.
- `bun checks:fix` passes, including the legacy native benchmark, type checking, lint/format checks, 668 CLI tests, 17 website tests, website build, and release packaging check. The three source report tests also pass with `bun test ./scripts/evals/report.test.ts`.
- Plugin/headless dependency checks, workflow YAML with eight unique targets, and roadmap links pass.
- Release `--version`, `--help`, `config-check`, `host-check`, and `storage-check` pass on macOS arm64 against a temporary home/workspace. Configured and credential secrets stay out of output; fixture files remain unchanged. Both Mach-O dependency lists contain only system libraries.
- All eight release executables build. Both Windows test suites also compile/link without execution. The workflow defines native-runner tests, Clippy, builds, boundary checks, and smoke checks for all targets, but no GitHub run is claimed.

### Foundation release sizes

These are as-built executable bytes, using the existing release profile (`panic = "unwind"`), without a post-build strip step. They are not full-feature results or approved budgets.

| Target                       |     Bytes | Build | Target execution                |
| ---------------------------- | --------: | ----- | ------------------------------- |
| `aarch64-apple-darwin`       | 1,529,104 | Pass  | Tests and release smoke pass    |
| `x86_64-apple-darwin`        | 1,584,752 | Pass  | Unverified; Rosetta unavailable |
| `x86_64-unknown-linux-gnu`   | 1,371,752 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-gnu`  | 1,207,600 | Pass  | Unverified; runner unavailable  |
| `x86_64-unknown-linux-musl`  | 1,360,280 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-musl` | 1,212,488 | Pass  | Unverified; runner unavailable  |
| `x86_64-pc-windows-msvc`     | 1,187,328 | Pass  | Unverified; runner unavailable  |
| `aarch64-pc-windows-msvc`    |   970,240 | Pass  | Unverified; runner unavailable  |

macOS builds use `cargo build -p xal-rust --release --target <target> --locked --offline`, with deployment targets 11.0 (arm64) and 10.13 (x64). Linux builds use the same options through `cargo zigbuild` (cargo-zigbuild 0.23.4, Zig 0.15.2). Windows builds use cargo-xwin 0.23.1's downloaded MSVC SDK/CRT environment and Rust's bundled linker:

```sh
target=x86_64-pc-windows-msvc
eval "$(cargo xwin env --target "$target")"
key="CARGO_TARGET_$(printf %s "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
env "$key=$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/rust-lld" \
  cargo build -p xal-rust --release --target "$target" --locked --offline
```

Repeat with `aarch64-pc-windows-msvc` for Windows arm64. Cross-compilation does not establish OS minimums, Windows ACL behavior, filesystem behavior, or runtime success on the other seven targets. GitHub execution was unavailable because local authentication is invalid; nothing was pushed or published. Real-target qualification remains required in the consuming phases.

### Local legacy-addon linker workaround

The default legacy addon build on this macOS 27/Bun 1.4.0 environment fails to load with `mis-aligned LINKEDIT string pool`; an untouched archive of the implementation base reproduces it. Full checks pass using the installed macOS 26.5 SDK and Rust's bundled Mach-O LLD:

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-fuse-ld=$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld64.lld" \
  bun checks:fix
```

This is an environment-only workaround, not a linker-policy or release change. The new executable needs neither the addon nor this workaround.

The phase tracker records implementation/review evidence. P03 owns full provider/auth/context behavior, P04 the wider tool/integration surface, P05 durable session/background workflows, P06 terminal parity, P07 the external runtime/SDK, and P08/P09 full qualification/cutover. P00 must not be revived as a prerequisite.
