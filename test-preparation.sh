#!/usr/bin/env bash

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEST_HOME="$(mktemp -d)"
REAL_XAL_HOME="${XAL_HOME:-$HOME/.xal}"

cleanup() {
  rm -rf "$TEST_HOME"
}

trap cleanup EXIT

cd "$ROOT"

if [[ -f "$REAL_XAL_HOME/config.json" ]]; then
  cp "$REAL_XAL_HOME/config.json" "$TEST_HOME/config.json"
else
  printf '{}\n' > "$TEST_HOME/config.json"
fi

for file in credentials.json trust.json; do
  if [[ -f "$REAL_XAL_HOME/$file" ]]; then
    cp -p "$REAL_XAL_HOME/$file" "$TEST_HOME/$file"
  fi
done

TEST_HOME="$TEST_HOME" bun -e '
  const path = `${process.env.TEST_HOME}/config.json`
  const config = await Bun.file(path).json()
  const redaction = config.redaction ?? {}
  config.redaction = {
    values: redaction.values ?? [],
    environment: [...new Set([...(redaction.environment ?? []), "XAL_REDACTION_TEST"])],
  }
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`)
'

cat <<'EOF'

When Xal opens, enter this prompt:

Use Bash to run exactly this command:

printf '%s\n' "$XAL_REDACTION_TEST" "$XAL_REDACTION_TEST" "$XAL_REDACTION_TEST"

Show me the command output verbatim.

Expected output:

[REDACTED]
[REDACTED]
[REDACTED]

The literal value native-redaction-test-7f3a91c2 must not appear in the tool output or assistant response.
Approve the Bash tool if prompted. Press Ctrl-C when finished.

EOF

XAL_HOME="$TEST_HOME" \
XAL_REDACTION_TEST="native-redaction-test-7f3a91c2" \
bun dev
