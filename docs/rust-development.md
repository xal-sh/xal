# Native Rust development

Phase 0 is not needed and is explicitly skipped and retired. Phases 1 through 3 are complete. P03 is closed at the user's request after implementation and local verification; controlled live provider/account checks remain unverified and are deferred to P08 qualification. P04 workspace tools and integrations are implemented and locally verified; the phase is blocked on its required Linux glibc/musl and Windows process-tree runtime evidence. No baseline/spike prerequisite remains. The local roadmap and phase-completion rule are in `.plans/rust/status.md` (Git-ignored); this document, implementation, fixtures, and checks are tracked.

## Development executable

`xal-rust` is a side-by-side, headless development executable, **not the released application**. The installed `xal`, website, installer, and update channels are unchanged. It includes all 13 provider IDs, a permission-enforced agent loop, native workspace/context tools, MCP and LSP integrations, and the gated `classify` decision tool. Terminal UI and an external plugin runtime remain later-phase work.

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

- `config-check` validates the core settings schema, exact-root trust, credentials, paths, and redaction. `XAL_HOME` is trimmed using JavaScript whitespace rules; an empty value falls back to `~/.xal`. The nearest `.git` file/directory defines the project root; outside Git the working directory is used. Only exactly trusted project roots contribute `.xal/config.json`. Nested objects merge; arrays/scalars replace. Missing files are allowed; malformed/inaccessible files fail without printing their contents or secret-bearing paths. Integration constructors validate their `pluginConfig` settings before use. Configured external plugins fail explicitly rather than executing JavaScript or being silently ignored.
- `host-check` exercises a read-only session, tool, authoritative policy evaluation, prompt/hooks, typed decision, bounded provider stream, events, and plain UI contribution through two independent native plugins. The `diagnostic` provider formats a local report; it is not an AI model and makes no network request.
- `storage-check` reads and round-trips version-2 session envelopes and conversation/history items, preserving unknown fields, opaque provider replay data, historical events, and omitted versus explicit null fields. Event payloads are opaque at this layer: it does not validate domain event semantics, replay sessions, repair truncation, or claim P05 recovery. Malformed JSON, invalid item envelopes, and truncated records fail visibly.
- Help/version do not load configuration. The three diagnostic commands never create, migrate, or rewrite user data; their results go to stdout and errors to stderr. Clean diagnostic interruption exits 130 after owned cleanup; cleanup failures remain errors. `run` creates a new session journal and may write model caches, tool artifacts, and authorized workspace files; its format and signal contract is described below.

Use `XAL_HOME` pointing at a temporary directory and a synthetic workspace to try these checks. Tests create isolated homes and never access personal configuration or credentials.

## Native headless run

```sh
cargo run -p xal-rust -- run --help
cargo run -p xal-rust -- run --provider openai --connection Test --model gpt-4.1 --format json "Read the fixture and report its contents"
printf '%s' 'Read the fixture and report its contents' | cargo run -p xal-rust -- run --model gpt-4.1
cargo run -p xal-rust -- run --model gpt-4.1 --format json --output-schema schema.json "Return the requested object"
```

Use a dedicated test `XAL_HOME` and a disposable workspace for live experiments. Native account commands below read and write the existing credential/profile and settings formats, including OAuth rotation; there is no environment-variable API-key store or automatic data migration. `run` selects explicit connection/provider/model overrides first, then saved preferences. Model catalogs use validated profile-bound caches, runtime discovery, or provider-specific bundled metadata, with fallback/save warnings on stderr. `XAL_<PROVIDER_ID>_BASE_URL` (uppercase, hyphens replaced by underscores) overrides the API endpoint for controlled fixtures, for example `XAL_OPENAI_BASE_URL`. HTTPS is required except for loopback HTTP; URL credentials, queries, fragments and redirects are rejected. Never send real credentials to an untrusted override.

- `run` accepts prompt words or, when absent, trimmed stdin. `--` ends option parsing. Modes are `normal`, `plan`, `yolo`, or configured custom names; deny rules remain authoritative. Plan sessions cannot modify files or run unsandboxed shell commands. Shell sandboxes are exposed only when supported on macOS.
- `--format text` prints the final answer, `json` prints one outcome object, and `jsonl` emits typed live events with the existing camelCase fields (`callId`, `readOnly`, usage counts). Diagnostics never go to JSONL stdout. Outcomes carry session/provider/model identity in JSON. Exit codes are 0 for completion, 1 for failure, 130 for SIGINT, and on Unix 143/129 for SIGTERM/SIGHUP after cancellation and owned cleanup.
- The loop composes the base/behavior/environment/permission prompts with registered prompt providers. It streams text, reasoning summaries, and tool calls; supports host-controlled input queues, steering, interruption, and bounded safe retries; and pairs interrupted calls with results before resuming. Identical tool/result loops are steered and then stopped. These are host APIs, not a new interactive stdin protocol.
- Registered tools include `read`, `write`, `edit`, `grep`, `glob`, foreground `bash`, `webfetch`, managed worktrees, `skill`, and primary-session `memory`; LSP and deferred MCP tools follow their availability gates. `classify` is available only with TypeSafe AI enabled. Tools run after argument hooks, schema/effect checks, and policy; read effects default to shared scheduling and writes to exclusive scheduling. Explicit scheduling metadata can override this independently of permissions: memory reads are exclusive, while MCP resource/prompt requests remain permission-sensitive but may overlap. Existing files require the session's current read hash before `write` or `edit(replace_all)`; ordinary exact edits retain their unique-match contract. File operations reject devices/FIFOs, validate opened handles, and check cancellation while scanning. Long read lines are bounded while their full content is hashed.
- Foreground shell cwd, exports, and functions persist within the session/sandbox. Concurrent read-sandbox calls can use isolated shells; sequential calls reuse state. Unix timeouts retain the shared shell's interrupt grace before a hard kill. Cancellation terminates and waits for the process tree. POSIX shell availability is required. Unix validates `$SHELL` and falls back to `/bin/sh` with a diagnostic. Windows requires a user-installed supported POSIX shell, such as Git for Windows; it does not silently use PowerShell or claim an OS sandbox. Windows launches suspended processes into owned kill-on-close Jobs before resuming them. Runtime qualification outside macOS remains an open P04 gate.
- Tool progress is incremental, redacted across chunk boundaries, bounded to 20 KiB, and delivered before completion. Raw final tool output is bounded to 2,000 lines and 50 KiB (20 KiB for shell); full redacted output is written to a secure `tool-<uuid>.txt` artifact under the session directory when needed. As in the legacy runner, eligible untruncated results may then receive a separately bounded read-ahead section (up to 24,000 bytes plus its separator); the combined persisted result can exceed the raw-tool cap. Unix artifacts/journals use `0600`, with newly created directories `0700`; storage failures are visible.
- Each run records a new version-2 JSONL session under the existing project-session path. Transient live events are not persisted; tool-argument updates follow their call items. The actual legacy reader is tested against both tool and compaction journals. This does not implement resume/fork, crash recovery, active-session handoff, or P05 ownership workflows.
- `--output-schema` requires a JSON-object schema and exposes the internal `submit_output` contract. It permits three correction attempts; ordinary text does not satisfy it. External schema references are disabled. Context admission accounts for the full request; ordinary summary compaction retains authored user messages and replaces history only after a complete, smaller summary has been journaled. Context overflow fails before an oversized provider request.

`--continue-from JOURNAL` copies the portable active history of a valid legacy version-2 journal into a new session. It supports direct-shell history and legacy, `user_messages_v1`, and `jev_v1` checkpoints; incomplete tool calls receive interrupted results. `--compact` performs manual compaction before the new prompt, with optional `--focus TEXT`. This is not in-place resume, truncated-tail recovery, fork/undo, or active-session ownership (P05). Unsupported image input is replaced by omission notices; provider-compatible image/reasoning replay remains available through typed host contracts. The native CLI has no image attachment picker yet.

Not included: goals, jobs, task agents, planning/interactive questions and durable session workflows (P05); TUI (P06); external plugins (P07). Unsupported goal/background/external-plugin requests receive explicit diagnostics. The native executable is not full product parity or a replacement for installed `xal`.

## Native workspace tools and integrations

P04 keeps shared algorithms in `xal-services`, with thin legacy NAPI adapters and independent native plugins. The released Bun CLI is still the compatibility oracle; no plugin imports a sibling plugin. Native integration commands use the same configuration/trust formats documented in [Integrations](integrations.md) and [Commands and skills](commands-and-skills.md).

```sh
cargo run -p xal-rust -- commands
cargo run -p xal-rust -- prompt inspect target
cargo run -p xal-rust -- review
cargo run -p xal-rust -- review main
cargo run -p xal-rust -- workspace-paths src test
cargo run -p xal-rust -- lsp
cargo run -p xal-rust -- lsp restart rust
cargo run -p xal-rust -- mcp
cargo run -p xal-rust -- mcp discover
cargo run -p xal-rust -- mcp reconnect server-name
cargo run -p xal-rust -- mcp import project --confirm
cargo run -p xal-rust -- mcp delete server-name --confirm
```

`prompt` and `review` print prepared instructions without calling a model. Use `run '/inspect target'`, `run '$skill-name task'`, or `run '/review main'` for a model-driven request. Authored input remains visible and persisted separately from its model-facing expansion. Inline skill references are not automatic invocations. Integration command help never loads configuration. Clean interruption preserves SIGINT 130 and Unix SIGTERM/SIGHUP 143/129 after owned cleanup; actual cleanup failures remain exit 1.

- **Files, search and fuzzy paths:** existing paging, UTF-16 edit behavior, read hashes, ignored-path traversal, ordering and error outputs share the legacy Rust implementations. `workspace-paths` returns at most 20 fuzzy matches; secret-bearing and ignored paths are excluded before ranking limits.
- **Web:** `webfetch` limits responses to 5 MiB and the complete operation to 30 seconds. It refuses private/internal addresses, pins validated DNS addresses, disables proxy routing, reports redirects without following them, decodes supported text charsets and converts HTML to Markdown. Binary responses and URL schemes other than HTTP(S) fail. Internal-address opt-in exists only for service fixtures, not the tool schema. URL permission subjects omit credentials.
- **Shell/process ownership:** foreground commands retain cwd/environment/functions per session and sandbox, with isolated fallback for overlapping calls. Output queues fail explicitly at 64 MiB rather than silently dropping unread data. Cancellation/drop/timeout and root exit terminate owned descendants. Unix process groups are lifecycle ownership, not a security boundary against deliberately detached processes. Owned pipe readers/writers stop independently of inherited pipes in detached helpers, preserving already-buffered output without hanging runtime shutdown. Only macOS `sandbox-exec` provides the advertised read/workspace OS restrictions; network is denied in either sandbox.
- **Worktrees:** writable primary sessions can enter, keep/exit, remove/exit, or remove another managed checkout. Dirty/untracked/ignored data blocks non-forced removal; force requests require policy approval. Managed markers, snapshot/index/submodule checks and cancellation cleanup share the native Git services. Workspace switches dispose session file/shell state, refresh cwd/context sources and emit persisted `workspace_changed` events. Task sessions cannot switch workspaces. End-to-end undo/redo, task inheritance and promotion remain P05.
- **MCP:** configured servers bootstrap concurrently with healthy survivors and visible redacted failure warnings. Stdio, streamable HTTP and 4xx legacy-SSE fallback are supported. Tools are deferred behind catalog search, instructions and exposure are session-scoped, and dynamic changes/reconnect/delete revalidate schemas/effects/permission subjects. Remote calls remain modifying effects regardless of advisory annotations. Resources, templates, prompts, progress and cancellation use bounded typed contracts. `.mcp.json` discovery is trust-gated and never implicitly enables a server in headless mode; imports require a trusted workspace, interactive stdin/stdout and `--confirm`. Import/delete preserve raw environment references and configuration source ownership. Language servers and MCP executables are user-managed; there are no implicit downloads.
- **LSP:** built-in recipes and strict overrides support executable discovery, nearest project roots, lazy per-root clients, UTF-16 positions, document synchronization, definitions/references/hover/symbols/implementations/call hierarchy and push/pull diagnostics. The read-only tool is advertised when a client is active, an enabled command resolves, or a relative PATH may resolve at the selected project root; definitive executable resolution occurs before launch. `lsp` and `lsp restart [server]` expose lifecycle/status without starting unused servers.
- **Context sources:** trusted hierarchical `AGENTS.md`, user/project Markdown commands, four-level skill precedence and bounded package/supporting-file loading feed the native prompt. Invalid skill packages warn without suppressing healthy packages. Global `<app-home>/MEMORY.md` retains revision/CAS, security and explicit-mutation requirements; task sessions cannot access it. `/review` supports working-tree and base-branch scopes, preserving Git failures rather than presenting them as an empty diff.

### P04 verification — local checks passed; runtime qualification blocked

Implementation/review base: `07702a140c949859db6f9634a2bcfd649112aca6`. Local environment: macOS 27 arm64, Rust 1.92.0 and Bun 1.4.0. Implementation, review fixes and available local checks are finished. **P04 is blocked, not complete:** its required Linux glibc/musl and Windows shell/process-tree execution evidence is unavailable. No release cutover, commit or publication was performed.

- **213 workspace Rust tests pass**, with one ignored subprocess helper explicitly launched by the process tests. Critical service/plugin fixtures use synthetic filesystems/Git repositories and native fake MCP/LSP executables; no external provider accounts are required.
- **`bun checks:fix` passes** with the environment-only legacy-addon workaround below: strict workspace Clippy, native benchmark, type checking, lint/format, 668 CLI tests, 17 website tests, website build and release packaging. The three source eval-report tests pass independently; ignored reference copies found by the broader script glob are not additional source tests.
- **Critical tool/integration cases pass:** denial and session-kind gates, artifacts/redaction, safe worktree switching and dirty/ignored-file protection, returning-workspace instruction/skill/trust refresh, argument-aware JSONL titles, explicit shared scheduling without weakened permissions, signal exits 130/143/129, MCP scoped reconnect cancellation and graceful shutdown, and LSP root-relative discovery and interruptible owned pipe cleanup. All HTTP/SSE connection cancellation stages retain interruption classification, while actual cleanup failures remain errors.
- **All eight release executables build.** Integration/service test binaries compile/link for all six Linux/Windows targets; both Windows architectures also pass strict all-target native Clippy. These are build results, not runtime results. macOS arm64 release compatibility, diagnostic/integration smokes, hidden UTF-8 input, terminal restoration and blocked-stdin cancellation pass. Both Mach-O binaries link only system libraries.
- **Legacy compatibility passes** with the real session/usage/profiler readers and eval JSONL consumers, including a clean archive of the fixed base without `node_modules` or an addon. Synthetic-home diagnostic checks leave configuration unchanged and emit no fixture secrets. Plugin boundaries, eight-target workflow YAML and links across all 14 roadmap documents pass.
- **All review findings are resolved.** The initial independent review covers 171 files / 282 hunks (+20,290/−7,854) on both Standards and Spec. Following the user's request to stop further delegation, the parent reviewed every fix delta below personally; those are not independent re-reviews. The combined inventories cover all 173 changed paths, with final evidence-only prose checked separately. The runtime exit gate remains open independently of code review.

Verification exposed a macOS process-exit/reap race, timestamp-colliding worktree fixtures and MCP cancellation error-kind loss. The fixes preserve genuine cleanup errors, use the existing UUID generator for fixture isolation and retain typed cancellation through HTTP/SSE error context. Focused regressions, eight repeated worktree suites and the final full checks pass; failures were corrected rather than waived.

| Review snapshot                      | Reviewer    | Files / hunks | Patch SHA-256                                                      |
| ------------------------------------ | ----------- | ------------- | ------------------------------------------------------------------ |
| Initial implementation               | Independent | 171 / 282     | `a88b7cf261865c3f6bbbb5b01f8b6fb6e2b317f9e25c1353c61a7f6d1a8e3555` |
| Review fixes                         | Parent      | 53 / 120      | `c80e89645e9aa2fc5b05203e05e6837d9f25d2e216970e841234e50a33a3ef83` |
| Fixture isolation / Windows import   | Parent      | 2 / 3         | `57c815c1674321a95e08a4d5500121e5dc72b47e52d0c8dc311844772e2886de` |
| HTTP/SSE cancellation classification | Parent      | 2 / 6         | `61a70a02fd821dc6c8934494c49932663b053f74e9b1024444efbc831afcaedf` |
| Explicit fixture EOF assertion       | Parent      | 1 / 1         | `9eef8c73aa4399b23d7d6b496c3482efbf02418e539945f7d21b1390e7c97c23` |

```sh
cargo test -p xal-services --test web --test fuzzy --test process --test git --test context_sources --test lsp --test mcp_stdio --test mcp_http --locked
cargo test -p xal-plugin-workspace -p xal-plugin-context -p xal-plugin-lsp -p xal-plugin-mcp --locked
cargo test -p xal-host --test dynamic --locked
cargo test -p xal-rust --test integrations --test headless --locked
bun checks:fix
```

The eight-target workflow includes every native integration plugin and runs these native tests on its target runners. P04 cannot be marked complete until shell/process-tree runtime checks pass on Linux glibc/musl and Windows as well as macOS. The local checkpoint lacked Linux/Windows runners and reported a GitHub authentication failure. Authenticated GitHub API access now succeeds, and the user has authorized commits and pushes to `rust` for CI qualification. The native workflow runs on `rust` pushes; no merge or release cutover is authorized. Remote runtime results are still pending, not inferred from cross-builds or deferred by the P03 live-account decision. P05 still owns durable sessions/jobs and end-to-end undo/redo; P06/P07 own the TUI and external runtime.

Local logs are under `target/p04-evidence/`: `checks-fix-passed.log`, `eight-builds-complete.log`, `test-delta-cross-final.log`, `release-gates-complete.log`, `mcp-legacy-final.log`, cancellation regression logs and `review-coverage-final.json`. Immutable review inventories are under `target/p04-review/`. These and `.plans/` remain Git-ignored; tracked implementation, fixtures, checks and this document are the durable delivery.

### P04 release sizes

These are as-built executable bytes with the existing release profile (`panic = "unwind"`), without a post-build strip step. They are milestone measurements, not full-feature results or approved budgets. Build commands, deployment targets, cross-tool versions and Windows prerequisites are recorded below.

| Target                       |      Bytes | Build | Target execution                |
| ---------------------------- | ---------: | ----- | ------------------------------- |
| `aarch64-apple-darwin`       | 25,832,160 | Pass  | Tests and release smoke pass    |
| `x86_64-apple-darwin`        | 27,731,760 | Pass  | Unverified; Rosetta unavailable |
| `x86_64-unknown-linux-gnu`   | 25,127,936 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-gnu`  | 22,145,256 | Pass  | Unverified; runner unavailable  |
| `x86_64-unknown-linux-musl`  | 24,057,376 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-musl` | 21,159,408 | Pass  | Unverified; runner unavailable  |
| `x86_64-pc-windows-msvc`     | 25,560,576 | Pass  | Unverified; runner unavailable  |
| `aarch64-pc-windows-msvc`    | 21,522,432 | Pass  | Unverified; runner unavailable  |

## Native accounts, models and decisions

Account commands return JSON to stdout; prompts, authorization URLs, fallback notices and errors go to stderr. API keys and pasted callbacks are read with terminal echo disabled, or from a pipe with `--key-stdin`; never place credentials in argv. Interrupts cancel pending input/network work and settle owned refresh/storage work before exiting.

```sh
cargo run -p xal-rust -- connect openai Test
cargo run -p xal-rust -- connect openai-chatgpt Subscription --method browser
cargo run -p xal-rust -- connect github-copilot Work --method device
cargo run -p xal-rust -- connections
cargo run -p xal-rust -- profiles rename Test Renamed
cargo run -p xal-rust -- models openai
cargo run -p xal-rust -- model gpt-5.6-sol --connection Renamed
cargo run -p xal-rust -- thinking high
cargo run -p xal-rust -- context-window 400000
cargo run -p xal-rust -- compaction-limit 300000
cargo run -p xal-rust -- logout Renamed
cargo run -p xal-rust -- usage
```

`connect PROVIDER --name NAME` is equivalent to the positional name form; the default name is the provider ID. `rename NAME NEW_NAME` is also supported. Connections are selected case-insensitively by name or by immutable ID. Explicit provider selection diagnoses multiple matching profiles rather than guessing; without explicit or saved selection, the first text profile in locale-aware name order is used. ICU collation and native locale detection preserve name ordering rather than ordering random UUIDs. Rename/refresh preserve IDs. Logout clears the saved harness selection only when it refers to the removed profile. Missing or mismatched profiles fail visibly.

`models [PROVIDER]` discovers each connected text profile; `models --connection NAME [--refresh]` selects one catalog. `model ID` saves the selected profile/provider/model. Thinking preferences keep the selected alias key, whereas context-window/compaction preferences use the canonical model key, matching the existing readers. Only supported thinking efforts/window choices are accepted; positive compaction limits remain subject to hard-window admission. `gpt-5.6-1m` and ChatGPT fast/large-window combinations retain their existing request mapping.

Provider configuration stays under `pluginConfig`: `openai.contextWindow` (default 260,000) and `openai.clientName` apply to API and ChatGPT identities; `github-copilot.enterpriseDomain` selects the GitHub Enterprise domain; `xai.baseUrl` and `alibaba-cloud.baseUrl` select HTTPS API endpoints. Text providers accept their existing `clientName`; unknown options fail. MiniMax account types share the `minimax` configuration key but keep separate credentials. See the released application's [provider documentation](providers.md) for account requirements; these native commands do not change the installed application's UI.

### Provider/account qualification matrix

Every row below has native implementation and deterministic protocol/authentication coverage. **All live checks are unverified:** no controlled test accounts were supplied or personal credentials inspected. Each row needs a dedicated test home/account, authenticated catalog discovery and a bounded generation/tool/reasoning continuation (typed decisions for TypeSafe). OAuth rows additionally require refresh/rotation and reconnect/disconnect checks; Copilot needs both personal and enterprise account-visible catalogs. Fixture success does not qualify third-party services.

| Provider ID / aliases         | Account paths requiring live evidence                | Native protocol                                      |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `openai` / `openai-api`       | API key                                              | Responses                                            |
| `openai-chatgpt` / `chatgpt`  | Browser PKCE, pasted callback, device login; refresh | Responses                                            |
| `anthropic` / `claude`        | API key                                              | Messages                                             |
| `google` / `gemini`           | API key                                              | Gemini                                               |
| `github-copilot` / `copilot`  | Personal and enterprise device login                 | Account-routed Chat Completions / Responses          |
| `xai` / `grok`                | API key and subscription device OAuth; refresh       | Responses                                            |
| `deepseek`                    | API key                                              | Chat Completions                                     |
| `alibaba-cloud` / `dashscope` | API key with configured regional endpoint            | Chat Completions                                     |
| `openrouter`                  | API key                                              | Chat Completions                                     |
| `minimax`                     | API key                                              | Messages                                             |
| `minimax-coding-plan`         | Coding-plan key                                      | Messages                                             |
| `opencode-go`                 | Go subscription key                                  | Model-routed Chat Completions / Responses / Messages |
| `typesafe` / `typesafeai`     | API key; Noul/Choice/Score inference                 | Decision API, never a harness text model             |

Alibaba, MiniMax and Go connection validation does not make a billable generation request. OpenRouter validates via its key endpoint; other API-key flows use discovery. OpenAI/ChatGPT caches retain legacy profile paths; Copilot caches additionally validate credential fingerprint/domain/version. Malformed caches and discovery failures produce visible fallback diagnostics; Copilot never falls back to another account's catalog. OAuth refresh is shared per immutable profile, uses the existing credential lock/CAS protocol and registers rotated secrets before use.

### Context, TypeSafe and request recording

`typesafe on --connection NAME` enables the selected TypeSafe profile without switching the harness model; `typesafe off` remembers the profile but disables inference and hides `classify`. Existing `typesafeAI` settings are reread before inference, so off/profile-change/disconnect takes effect without leaking state to an old account. The decision service validates/redacts input, rejects secret-bearing identifiers rather than merging them, validates typed responses, bounds requests/retries and records reported usage.

`classify` keeps the existing 30,000-token pair, 60,000-token request and 100-request batching limits, sequential batches and five-minute operation deadline. Jev prunes atomically while protecting authored user messages, the first item and recent items/tool pairs; failed/no-op decisions visibly fall back to ordinary summaries. Manual/automatic summaries use the provider's supported low-effort/fast target and commit only complete, smaller history/checkpoint replacements; cancellation or checkpoint delivery failure preserves original history. Admission estimates the full provider request, including instructions, schemas and images.

Read-ahead runs only when TypeSafe is enabled. It limits candidates to 40, selects at most four files, bounds inserted context to 24,000 bytes and the operation to five seconds. Git candidate output is bounded to 64 KiB. Every prefetched read uses normal path/effect/permission checks; denied/approval-required/unreadable files are skipped. Speculative reads do not run ordinary tool hooks, create tool artifacts or authorize subsequent writes by populating read hashes. Failures are visible and do not replace authored prompt text.

Request-boundary recording includes text, decisions, summaries and read-ahead, with failed/interrupted reported usage retained even if event delivery stops. New secure usage JSONL records are version 2, with SHA-256 session fingerprints and all four token counts; the native `usage` command reads v1/v2 aggregate totals. `run --profile` enables content-free timing/shape records under `profiler/`. Prompts, completions, tool arguments/paths, credentials and raw session/profile IDs are not profiler content. Usage failures latch and fail the run; profiler failures warn and disable profiling rather than inference. The actual legacy readers verify request/turn observations and session/weekly/daily attribution. Native session/calendar charts and interactive usage views remain P05/P06 consumers, not P03 request recording.

### Deterministic verification

No credentials are needed for these checks; all HTTP responses and homes/workspaces are synthetic:

```sh
cargo test -p xal-host --test agent --test permissions --locked
cargo test -p xal-rust --test headless --locked
cargo test -p xal-services -p xal-providers -p xal-plugin-providers -p xal-plugin-classify --locked
cargo test -p xal-host --test context --test recording --locked
cargo test -p xal-rust --test accounts --test prefetch --locked
cargo build -p xal-rust --locked
bun scripts/rust/check-headless.ts
bun scripts/rust/check-boundaries.ts
python3 scripts/rust/check-terminal.py
```

The headless fixtures cover read/edit/verify, stdin/formats/usage/retry/redaction, denial without effects, malformed tool arguments, stale writes, partial streams, structured-output failure, oversized artifacts, context overflow, transactional summary compaction, repeated loops, signal/process-tree settlement, regular-file checks, and shell state across timeout/sandbox boundaries. Host tests cover hooks/effective arguments, read concurrency/write exclusion, queue/steer result pairing, sink-failure cleanup, uncooperative callbacks, and cancellation with saturated output (including redactor tails). Transport/schema tests cover chunked UTF-8/CRLF/multiline SSE, malformed/truncated/oversized records, model-bound reasoning replay, noncompleted Responses status, and external-reference refusal.

`scripts/rust/check-headless.ts [binary]` runs the real executable against loopback fixtures, consumes eval-style JSONL fields, and loads its journals with the unchanged legacy session reader, and verifies native request/turn observations and session-attributed usage with the actual legacy profiler/usage readers. It also checks that loading does not repair/rewrite the journals. Bun is used only by the compatibility harness, not by `xal-rust`. The eight-target workflow includes all native provider/decision crates and the release-binary compatibility smoke; Unix runners also exercise hidden UTF-8 input, terminal restoration and blocked-stdin cancellation with the PTY script. The PTY comparison ignores only the kernel-managed transient PENDIN flag. Windows console code requires native-runner execution; remote execution is not claimed.

### P03 verification — complete; live qualification deferred

Implementation/review base: `fd3f5f046d28c9124403eefc1010e7f0884fcbec`. Local environment: macOS 27 arm64, Rust 1.92.0, Bun 1.4.0. Implementation, deterministic checks, independent review/fixes, and local build gates are finished. **P03 is closed at the user's explicit request.** The remaining controlled live authentication/discovery/stream checks are deferred to P08 qualification, not marked passed; the account matrix above records the dedicated test accounts and evidence still required.

- **142 workspace Rust tests pass**, including 20 provider tests, nine context tests, four classify tests, two recording tests, 15 headless tests and the account/prefetch regressions. Fifteen two-turn provider/protocol routes cover all 12 text-provider IDs; 21 parameterized thinking-family cases complement the TypeSafe decision fixtures.
- **`bun checks:fix` passes** with the environment-only addon workaround below, including workspace Clippy with `-D warnings`, native benchmark, type checking, lint/format, 668 CLI tests, 17 website tests, website build and release packaging. The three source eval-report tests pass separately; ignored reference copies found by the broader script glob are not additional source tests.
- **Critical account/context cases pass:** OAuth pending/slow-down/denial, PKCE/state/callbacks, shared refresh and CAS after rename/disconnect/replacement, profile-bound catalog fallback, alias-specific thinking, locale-aware default selection, historical checkpoints, hard admission, atomic compaction/fallback, TypeSafe off-state gating, classify batching/deadlines, bounded permission-aware read-ahead, and failed/interrupted usage retention/privacy.
- A final full-suite run exposed fractional OAuth expiry precision loss during JSON parsing. The deterministic regression failed before the fix at fractional millisecond `6/4096`, then passed all 4,096 positions, physical storage readback and CAS replacement after enabling the existing `serde_json` `float_roundtrip` feature in shared storage. Exact credential comparison is unchanged; no expiry rounding or weakened CAS was introduced.
- **Release compatibility passes** for read/edit/verify, compaction, eval JSONL and actual legacy session/usage/profiler readers, including session/weekly/daily attribution. It also passes against an isolated archive of the fixed implementation base, without `node_modules` or a native addon; only the profiler observation helper is exported for the probe. Initial archive-probe setup mistakes were corrected before this passing run. Synthetic homes/workspaces are removed afterward; no personal credentials were inspected or modified.
- **All eight release executables build**, and both Windows architectures' native test binaries compile/link. macOS arm64 release version/help/config/host/storage diagnostics, hidden UTF-8 input, terminal restoration and blocked-stdin interruption pass. Read-only diagnostics leave the fixture home unchanged. Both Mach-O binaries link only system libraries. Plugin boundaries, workflow YAML with eight unique targets, all 14 roadmap documents' links, Rust formatting and diff whitespace checks pass.
- **Independent review passes Standards and Spec with zero remaining blockers.** The initial 59-file/141-hunk implementation review, 94-hunk intermediate closure, and final deltas below reconcile to all 75 changed paths. Every reviewed addition/deletion has both-axis coverage; final evidence-only prose/tracker updates are parent-checked against observed logs, bytes and access limitations.

| Final review delta                                         | Files / hunks | Patch SHA-256                                                      |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| Accounts                                                   | 5 / 8         | `53084ffd4242e9bf3f3b881cec7380ec8371e915ed338954922b35cd0a4da38b` |
| Protocols and fixtures                                     | 5 / 73        | `93ac39d488e4bae50fdd8f76572c62ab72b07d46c05d1a6948ae423c9ae4c9f6` |
| Context and classify                                       | 5 / 13        | `79a68c0d752a70cb912187fc4fcc69ca3e7725d3e1dacf5144201b15b4893232` |
| Integration                                                | 14 / 44       | `aa790c3bece5477c27ff898c30ae82e0108920dbb9b3a248f4a78aa6bcd90d2a` |
| Exact expiry readback and documented model/window sequence | 3 / 3         | `6c1c9e2af79e361ff622f48f19327939c775bf4c54c46fadce74043b426e829a` |

Local raw evidence is under `target/p03-evidence/`: `checks-fix-verified.log`, `eight-builds-verified.log`, `release-gates.log`, `clean-consumers-final.log`, `expiry-before.log`, `expiry-after.log`, `expiry-suite.log`, and `review-coverage-final.json`. Frozen review inventories/snapshots are under `target/p03-review/`. These ignored local artifacts are not the durable delivery; tracked code, fixtures, verification scripts and this document are.

No live provider/account path is marked passed. Remote CI, the other seven target runtimes, Windows console/ACL execution, OS minimums and full platform qualification remain **unverified**, not inferred from cross-builds. The account matrix specifies the access and controlled checks still required for P08 qualification. The user authorized a local P03 commit only; no push, publication or native release cutover is authorized.

### P03 release sizes

These are as-built executable bytes with the existing release profile (`panic = "unwind"`), without a post-build strip step. They are milestone measurements, not full-feature results or approved budgets. Commands, deployment targets and cross-build tool versions are recorded below with the earlier phase evidence.

| Target                       |      Bytes | Build | Target execution                |
| ---------------------------- | ---------: | ----- | ------------------------------- |
| `aarch64-apple-darwin`       | 16,116,832 | Pass  | Tests and release smoke pass    |
| `x86_64-apple-darwin`        | 17,653,912 | Pass  | Unverified; Rosetta unavailable |
| `x86_64-unknown-linux-gnu`   | 16,101,688 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-gnu`  | 13,834,216 | Pass  | Unverified; runner unavailable  |
| `x86_64-unknown-linux-musl`  | 15,498,760 | Pass  | Unverified; runner unavailable  |
| `aarch64-unknown-linux-musl` | 13,298,168 | Pass  | Unverified; runner unavailable  |
| `x86_64-pc-windows-msvc`     | 15,192,064 | Pass  | Unverified; runner unavailable  |
| `aarch64-pc-windows-msvc`    | 12,989,952 | Pass  | Unverified; runner unavailable  |

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

### P02 headless release sizes — historical

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

| Crate                    | Responsibility                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xal-rust`               | Executable composition root, diagnostics, and headless `run` argument/output/signal handling.                                                                                                                                                                                                                                      |
| `xal-host`               | Typed session/event, command, tool, provider/decision, hook, prompt, policy, and UI contracts. Per-host staged registries, asynchronous bootstrap/readiness, cancellation, bounded queues, owned subscriptions/tasks/disposers, failure reporting, reverse shutdown.                                                               |
| `xal-services`           | Config/trust/path resolution, validated settings, secure atomic storage, credentials/immutable profile IDs, session-envelope codecs, shared UTF-16 and streaming/JSON redaction, shared file/search/fuzzy/web/process/shell/Git/worktree/MCP/LSP/context-source algorithms, JSON Schema validation and bounded HTTP/SSE transport. |
| `xal-plugin-inspect`     | Read-only config/storage commands and inspection tool/policy.                                                                                                                                                                                                                                                                      |
| `xal-plugin-diagnostics` | Local report provider/decision, prompt/hook, and plain renderer.                                                                                                                                                                                                                                                                   |
| `xal-providers`          | Shared typed protocol, catalog, authentication and profile services for all 13 IDs. No plugin sibling dependency.                                                                                                                                                                                                                  |
| `xal-plugin-providers`   | Thin native provider/decision registrations consuming the shared provider services; replaces the first OpenAI-only plugin.                                                                                                                                                                                                         |
| `xal-plugin-classify`    | Independent classify tool consuming the host decision service, not a sibling provider plugin.                                                                                                                                                                                                                                      |
| `xal-plugin-workspace`   | Independent files, search, foreground shell, web and worktree registrations using host policy and shared services.                                                                                                                                                                                                                 |
| `xal-plugin-context`     | Independent instructions, Markdown commands, skills, global memory and code-review registrations.                                                                                                                                                                                                                                  |
| `xal-plugin-lsp`         | Native LSP settings, query/lifecycle commands, availability and renderer contributions.                                                                                                                                                                                                                                            |
| `xal-plugin-mcp`         | Native MCP settings/project discovery, deferred tool/catalog/prompt registration and lifecycle commands.                                                                                                                                                                                                                           |
| `xal-native`             | Thin legacy N-API adapters over shared services, plus remaining P05 tool contracts. Addon cache hashing includes shared sources.                                                                                                                                                                                                   |

Plugins depend on host contracts/services, never sibling implementations. `bun scripts/rust/check-boundaries.ts` checks the workspace graph and the executable's normal dependency tree. No N-API, JS scheduling, addon loading, terminal, or Wasm dependency exists in the native executable. Bun runs this repository check, not the executable.

Registration is synchronous and staged; bootstrap and callbacks may be asynchronous. Contributions become callable only after owner readiness. Duplicate identities/capabilities, failures, panics, and cancellation discard the failed owner's complete staged contributions, close its subscriptions, and clean up owned resources. Healthy owners remain available when another owner fails. Provider queues backpressure; event queue overflow or a closed subscription is a visible error, never a silent drop. Cancellation is hierarchical across host, owner, and session operations; callback-local cancellation cannot report success or cancel sibling calls. Hooks run in owner order and then registration order, preserving replacement semantics.

Tool invocation runs before-tool hooks before policy checks; any policy denial wins over allows, requests for approval cannot be bypassed by allows, read-only sessions reject modifying tools, and no explicit allow means approval is required. The native headless path also applies normal/plan/yolo/custom and remembered rules; yolo skips asks but never overrides denials. Unresolved shell expansions and wrapper options fail closed when applicable shell-deny rules exist, including sandboxed requests. Command candidates and lookup exemptions use the same operand-aware wrapper parser. Approval-required headless actions are refused without effects.

Shutdown cancels owners, visits plugins in reverse registration order, joins/aborts owned tasks, and disposes resources in reverse ownership order. Callback panics and cleanup errors remain visible without skipping remaining cleanup. Async shutdown/disposers have a five-second deadline per callback. Await lifecycle futures to settlement; request cancellation through the token rather than dropping startup/rollback or shutdown futures. Call `shutdown().await` explicitly; dropping an active host cancels/aborts tasks and diagnoses the missing shutdown, but cannot run arbitrary asynchronous disposers. The executable cancels and awaits interrupted startup/rollback before shutting down, and explicitly shuts down on success and failure too. Native callbacks remain trusted/cooperative code; preemptive isolation belongs to the external runtime phase.

## Persistence foundations

The diagnostic commands only read. The following foundations also support `run`; verification uses synthetic fixtures:

- Settings patches validate the merged effective configuration before atomically replacing the user file. Unknown raw fields are preserved. Trusted project overrides are not copied into the user file. The explicit TypeSafe setting update removes the same obsolete user fields as the legacy writer. Trust grants/revocations preserve exact path-string identity.
- Secure writes use an exclusive same-directory temporary file, flush data, then atomically rename. Unix files are mode `0600` and directory metadata is synced. Windows new files have a protected owner/System DACL. Temporary cleanup failures are reported. Readers/writers reject symlink/non-regular final paths; JSON/text files are bounded to 64 MiB. Windows ACL execution and filesystem semantics require real-runner verification, not just cross-compilation.
- Credential wire format remains `{"profiles":{"id":{"name","provider","credential"}}}`. API keys and OAuth access/refresh/expiry/account identity round-trip; IDs stay unchanged by rename/refresh, and new IDs are random UUIDv4. Names use JavaScript trim, an 80-UTF-16-unit limit, control-character rejection, and case-insensitive uniqueness. The legacy empty-directory `credentials.json.lock` protocol is retained (25 ms poll, 10 s wait/stale threshold); no incompatible lock-file scheme is introduced. Mutations lock before reading, reject malformed stores/provider mismatches, and refresh uses compare-and-swap rather than overwriting newer credentials. Lock contention cancellation does not remove another writer's lock. Profile presentation sorting is a UI concern, not a storage guarantee.
- The extracted redactor preserves UTF-16 code-unit matching, overlap priority, marker collision handling, and lone-surrogate behavior of the legacy matcher. Native text streams consult an extendable secret snapshot, protect newly rotated credentials even in already-created streams, hold prefixes across chunks, and flush at end; JSON keys and values are redacted. The inspection report includes both configured/environment secrets and stored credential secrets. OAuth and API-key consumers register credentials before requests or output. Decision identities are validated rather than redacted into colliding model/question/choice keys.
- Session-envelope fixtures preserve persisted objects without automatic migration. Full domain-event validation, mixed-process active-session ownership/recovery, background formats, and full resume/handoff workflows belong to their consuming phases. No reader success is labeled full persistent-data parity.

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
