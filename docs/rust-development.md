# Native Rust development

Phase 0 is not needed and is explicitly skipped and retired. Phase 1 is complete, with its implementation and verification recorded below; no baseline/spike prerequisite remains. The local roadmap and phase-completion rule are in `.plans/rust/status.md` (Git-ignored); this document, implementation, fixtures, and checks are tracked.

## Development executable

`xal-rust` is a side-by-side, headless development executable, **not the released application**. The installed `xal`, website, installer, and update channels are unchanged. No AI provider, agent loop, workspace tools, terminal UI, or external plugin runtime is claimed by the foundation.

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
- Help/version do not load configuration. Commands never create, migrate, or rewrite user data. Success goes to stdout, errors to stderr; clean interruption exits 130 after owned cleanup; cleanup failures remain errors.

Use `XAL_HOME` pointing at a temporary directory and a synthetic workspace to try these checks. Tests create isolated homes and never access personal configuration or credentials.

## Boundaries and ownership

| Crate                    | Responsibility                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xal-rust`               | Executable composition root and local diagnostic workflow.                                                                                                                                                                                                           |
| `xal-host`               | Typed session/event, command, tool, provider/decision, hook, prompt, policy, and UI contracts. Per-host staged registries, asynchronous bootstrap/readiness, cancellation, bounded queues, owned subscriptions/tasks/disposers, failure reporting, reverse shutdown. |
| `xal-services`           | Config/trust/path resolution, validated settings, secure atomic storage, credentials/immutable profile IDs, session-envelope codecs, shared UTF-16 and streaming/JSON redaction.                                                                                     |
| `xal-plugin-inspect`     | Read-only config/storage commands and inspection tool/policy.                                                                                                                                                                                                        |
| `xal-plugin-diagnostics` | Local report provider/decision, prompt/hook, and plain renderer.                                                                                                                                                                                                     |
| `xal-native`             | Legacy N-API adapter plus services not yet consumed by the rewrite. Redaction calls the extracted shared matcher; addon cache hashing includes shared sources.                                                                                                       |

Plugins depend on host contracts/services, never sibling implementations. `bun scripts/rust/check-boundaries.ts` checks the workspace graph and the executable's normal dependency tree. No N-API, JS scheduling, addon loading, terminal, or Wasm dependency exists in the native executable. Bun runs this repository check, not the executable.

Registration is synchronous and staged; bootstrap and callbacks may be asynchronous. Contributions become callable only after owner readiness. Duplicate identities/capabilities, failures, panics, and cancellation discard the failed owner's complete staged contributions, close its subscriptions, and clean up owned resources. Healthy owners remain available when another owner fails. Provider queues backpressure; event queue overflow or a closed subscription is a visible error, never a silent drop. Cancellation is hierarchical across host, owner, and session operations; callback-local cancellation cannot report success or cancel sibling calls. Hooks run in owner order and then registration order, preserving replacement semantics.

Tool invocation runs before-tool hooks before policy checks; any policy denial wins over allows, requests for approval cannot be bypassed by allows, read-only sessions reject modifying tools, and no explicit allow means approval is required. This is the host enforcement boundary, not the later-phase complete permission-pattern engine.

Shutdown cancels owners, visits plugins in reverse registration order, joins/aborts owned tasks, and disposes resources in reverse ownership order. Callback panics and cleanup errors remain visible without skipping remaining cleanup. Async shutdown/disposers have a five-second deadline per callback. Await lifecycle futures to settlement; request cancellation through the token rather than dropping startup/rollback or shutdown futures. Call `shutdown().await` explicitly; dropping an active host cancels/aborts tasks and diagnoses the missing shutdown, but cannot run arbitrary asynchronous disposers. The executable cancels and awaits interrupted startup/rollback before shutting down, and explicitly shuts down on success and failure too. Native callbacks remain trusted/cooperative code; preemptive isolation belongs to the external runtime phase.

## Persistence foundations

The native development commands only read; write APIs are exercised against synthetic fixtures:

- Settings patches validate the merged effective configuration before atomically replacing the user file. Unknown raw fields are preserved. Trusted project overrides are not copied into the user file. The explicit TypeSafe setting update removes the same obsolete user fields as the legacy writer. Trust grants/revocations preserve exact path-string identity.
- Secure writes use an exclusive same-directory temporary file, flush data, then atomically rename. Unix files are mode `0600` and directory metadata is synced. Windows new files have a protected owner/System DACL. Temporary cleanup failures are reported. Readers/writers reject symlink/non-regular final paths; JSON/text files are bounded to 64 MiB. Windows ACL execution and filesystem semantics require real-runner verification, not just cross-compilation.
- Credential wire format remains `{"profiles":{"id":{"name","provider","credential"}}}`. API keys and OAuth access/refresh/expiry/account identity round-trip; IDs stay unchanged by rename/refresh, and new IDs are random UUIDv4. Names use JavaScript trim, an 80-UTF-16-unit limit, control-character rejection, and case-insensitive uniqueness. The legacy empty-directory `credentials.json.lock` protocol is retained (25 ms poll, 10 s wait/stale threshold); no incompatible lock-file scheme is introduced. Mutations lock before reading, reject malformed stores/provider mismatches, and refresh uses compare-and-swap rather than overwriting newer credentials. Lock contention cancellation does not remove another writer's lock. Profile presentation sorting is a UI concern, not a storage guarantee.
- The extracted redactor preserves UTF-16 code-unit matching, overlap priority, marker collision handling, and lone-surrogate behavior of the legacy matcher. Native text streams use an immutable secret snapshot, hold prefixes across chunks, and flush at end; JSON keys and values are redacted. The inspection report includes both configured/environment secrets and stored credential secrets. Secret changes during live provider sessions remain the consuming provider phase's responsibility.
- Session-envelope fixtures preserve persisted objects without automatic migration. Full domain-event validation, mixed-process active-session ownership/recovery, usage/cache/background formats, and live continuation belong to their consuming phases. No reader success is labeled full persistent-data parity.

## Verification

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

The phase tracker records implementation/review evidence. P02 owns the first real provider/tool loop, P06 the terminal choice/parity, P07 the external runtime/SDK, and P08/P09 full qualification/cutover. P00 must not be revived as a prerequisite.
