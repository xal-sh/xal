# Installation and beta releases

> **Beta:** Xal is currently in beta. Only beta releases are available to install, and breaking changes may occur before the first stable release.

## Install the beta

The installer downloads the latest beta as one native executable, verifies its SHA-256 checksum, and places it in `~/.local/bin`.

```bash
curl -fsSL https://xal.sh/install | sh -s -- --beta
```

Run Xal from any project after installation:

```bash
xal
```

The supported targets are:

| Operating system | Architectures | Variants      |
| ---------------- | ------------- | ------------- |
| macOS            | x64, arm64    | Native        |
| Linux            | x64, arm64    | glibc, musl   |
| Windows          | x64, arm64    | Native `.exe` |

Windows installation requires a POSIX shell such as Git Bash, MSYS2, or Cygwin. Running the command in WSL installs the Linux build inside WSL.

Set `XAL_INSTALL_DIR` on the shell that runs the installer to choose another destination:

```bash
curl -fsSL https://xal.sh/install | XAL_INSTALL_DIR="$HOME/bin" sh -s -- --beta
```

The destination must be on `PATH` before `xal` can be invoked by name.

## Update the beta

`xal update` installs the newest beta release:

```bash
xal update
```

A beta version has the form `X.Y.Z-beta.N`.

## Beta release process

Every push to `main` runs `.github/workflows/release-beta.yml`. The workflow runs all repository checks, derives the beta version from `apps/cli/package.json` and the commit count, and builds every supported target on its matching architecture. Each release executable contains its target-specific Rust addon and verifies the lightweight version path, native-backed self-check, external plugin redaction, and musl TUI initialization before publication.

Each successful run publishes:

- A versioned GitHub prerelease tagged `vX.Y.Z-beta.N` whose assets are never overwritten by the workflow.
- A rolling `version.txt` pointer under the `beta` release tag.
- `version.txt` and `SHA256SUMS` metadata used by the installer and updater.

The installer and updater resolve the rolling pointer first, then download the executable and checksums from the complete versioned prerelease.

Change the version in `apps/cli/package.json` on `main` when beta development should begin for a new stable version.

## Stable rollout

Stable releases and stable installation are not available during the beta rollout. The **Release stable** workflow is reserved for promoting a tested beta after Xal is ready to leave beta.
