import { expect, test } from "bun:test"
import { compactCommandTitle } from "./title"

test("summarizes a multi-line script by its first real command", () => {
  expect(compactCommandTitle("ls -ld /tmp/example")).toBe("ls -ld /tmp/example")
  expect(compactCommandTitle("set -e\nrm -rf /tmp/example\nmkdir /tmp/example")).toBe("rm -rf /tmp/example · +1 more")
  expect(compactCommandTitle("set -euo pipefail\ncd /repo\nbun run checks")).toBe("bun run checks")
  expect(compactCommandTitle("# prepare\nFOO=1\nexport BAR=2\n\nbun test")).toBe("bun test")
  expect(compactCommandTitle("set -e\nset -u")).toBe("set -e · +1 more")
  expect(compactCommandTitle("")).toBe("")
})
