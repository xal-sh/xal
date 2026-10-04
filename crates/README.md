# Native Rust rewrite

`xal-rust` is the side-by-side development executable of the Rust rewrite. It is **not** the released application: the installed `xal`, the website, the installer and the update channels still ship the Bun/TypeScript app in `apps/cli` with its `xal-native` addon. `xal-rust` runs headless sessions, session and background management, accounts and models, and the MCP and LSP integrations. It has no terminal UI yet.

```sh
cargo run -p xal-rust -- --help
```

## Separate home

Always run `xal-rust` with its own `XAL_HOME`, such as a temporary directory or a dedicated test home, and a disposable workspace. Never point it at the home the installed `xal` uses. The Rust session lock only excludes other Rust processes, so the two apps must not write the same data at the same time. To try existing data, copy it into the test home first.

## Checks

```sh
cargo fmt --all -- --check
cargo clippy --workspace --exclude xal-native --all-targets --locked -- -D warnings
cargo test --workspace --exclude xal-native --all-targets --locked
```

`.github/workflows/rust.yml` runs these on Linux x64, macOS arm64 and Windows x64 for pushes and pull requests. Its eight-target build and test matrix runs only on manual dispatch, for qualification and releases or after platform-specific changes. `bun checks` covers only the TypeScript app and the `xal-native` addon.

The fixtures under `xal-services/tests/fixtures/ts` and `xal-host/tests/fixtures/usage` were written by the TypeScript app. Keep them byte-exact: they are excluded from Prettier and line-ending conversion.

## Cross-builds

Prefer the dispatched CI matrix. To build a target locally, fetch its dependencies with `cargo fetch --locked --target <target>`, then:

- **macOS:** `cargo build -p xal-rust --release --target <target> --locked`, with `MACOSX_DEPLOYMENT_TARGET` set to `11.0` for arm64 and `10.13` for x64.
- **Linux:** the same arguments through `cargo zigbuild` (cargo-zigbuild 0.23.4, Zig 0.15.2).
- **Windows:** cargo-xwin 0.23.1's MSVC SDK/CRT environment with Rust's bundled linker. Cross-building from macOS also needs NASM and an LLVM librarian:

  ```sh
  rustup component add llvm-tools-preview
  brew install nasm
  mkdir -p target/windows-tools
  ln -sf "$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/llvm-ar" target/windows-tools/llvm-lib
  export PATH="$PWD/target/windows-tools:$PATH"

  target=x86_64-pc-windows-msvc
  eval "$(cargo xwin env --target "$target")"
  key="CARGO_TARGET_$(printf %s "$target" | tr '[:lower:]-' '[:upper:]_')_LINKER"
  env "$key=$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/rust-lld" \
    cargo build -p xal-rust --release --target "$target" --locked
  ```

  Build `aarch64-pc-windows-msvc` in a fresh shell so target-specific compiler flags do not accumulate.

A successful cross-build does not show that the binary runs on that target.

## Live provider checks

Provider protocols and authentication have deterministic tests only. Each row still needs a live check with a dedicated test home and account: authenticated catalog discovery, then a bounded generation with a tool call and reasoning continuation (typed decisions for TypeSafe). OAuth rows also need refresh, rotation, reconnect and disconnect checks.

| Provider ID / aliases         | Account paths                                        | Protocol                                             |
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

Copilot needs both personal and enterprise account catalogs, and must never fall back to another account's catalog.

## Local legacy-addon linker workaround

On macOS 27, the default legacy addon build fails to load with `mis-aligned LINKEDIT string pool`. Build it with the installed macOS 26.5 SDK and Rust's bundled Mach-O LLD:

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-fuse-ld=$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/ld64.lld" \
  bun checks:fix
```

This only changes the local environment, not the linker policy or releases. `xal-rust` needs neither the addon nor this workaround.
