# Xal (Zal)

> [!IMPORTANT]
> Xal is currently in beta. Only beta releases are available, and breaking changes may occur before the first stable release.

A terminal coding harness with a headless agent core where every capability, is a plugin

Powered by [OpenTUI](https://github.com/anomalyco/opentui)

## Features

- Terminal UI
- Headless mode
- Multiple providers
  - OpenAI API
  - OpenAI ChatGPT
  - GitHub Copilot
  - xAI
  - DeepSeek
  - Alibaba Cloud
  - Anthropic plugin
  - More coming
- Model discovery
- Connection profiles
- Thinking controls
- Plugins and hooks
- MCP servers
- Language servers
- Project instructions
- Custom commands
- Skills
- Permission modes
- Plan mode
- Secret redaction
- Background sessions
- Task agents
- Background processes
- Custom keybindings
- Terminal notifications
- Goals

## Install the beta

Install the latest beta release on macOS, Linux, or Windows from a POSIX shell:

```bash
curl -fsSL https://xal.sh/install | sh -s -- --beta
```

The installer supports x64 and arm64, including glibc and musl Linux. On Windows, run it from Git Bash, MSYS2, or Cygwin. It installs to `~/.local/bin` by default.

Run Xal from any project:

```bash
xal
```

Update to the latest beta release:

```bash
xal update
```

There is no stable installation channel during the beta rollout. See the [installation and beta release guide](docs/install.md) for custom paths, supported platforms, and the release process.

## Documentation

The [documentation](https://xal.sh/docs) covers configuration, the TUI, permissions, providers, integrations, plugins, reusable instructions, commands and skills, goals, and background work. The Markdown sources live in [`docs`](docs).

## Run with Profiler

Run with `--profile` to store anonymous session diagnostics and print the profile path when the app exits.

## Development

Local development requires Bun 1.3.14 and Rust 1.92.0. The first development or test run builds the native addon for the host and caches it under `apps/cli/.native`. Restart `bun dev` after changing Rust code.

```bash
bun install
bun dev
```

Run `bun native:benchmark` to compare the Rust secret matcher with the previous TypeScript path on the host. Compare compiled startup with `bun native:benchmark:startup <baseline-executable> <current-executable>`.

## License

Xal is available under the [MIT License](LICENSE).
