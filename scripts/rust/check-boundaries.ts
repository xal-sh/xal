import { isRecord } from "../../apps/cli/src/lib/json"

const metadata = Bun.spawn(["cargo", "metadata", "--no-deps", "--format-version", "1", "--locked", "--offline"], {
  stdout: "pipe",
  stderr: "inherit",
})
const raw: unknown = await new Response(metadata.stdout).json()
if ((await metadata.exited) !== 0) throw new Error("cargo metadata failed")
if (!isRecord(raw) || !Array.isArray(raw.packages)) throw new Error("invalid cargo metadata")
const packages = raw.packages.map((value: unknown) => {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.dependencies))
    throw new Error("invalid cargo package")
  const dependencies = value.dependencies.map((dependency: unknown) => {
    if (!isRecord(dependency) || typeof dependency.name !== "string") throw new Error("invalid cargo dependency")
    return dependency.name
  })
  return { name: value.name, dependencies }
})
const byName = new Map(packages.map((entry) => [entry.name, entry]))
function walk(name: string, visited = new Set<string>()): Set<string> {
  if (visited.has(name)) return visited
  visited.add(name)
  for (const dependency of byName.get(name)?.dependencies ?? []) walk(dependency, visited)
  return visited
}
for (const entry of packages) {
  if (!entry.name.startsWith("xal-plugin-")) continue
  for (const dependency of walk(entry.name)) {
    if (dependency !== entry.name && dependency.startsWith("xal-plugin-"))
      throw new Error(`${entry.name} imports sibling plugin ${dependency}`)
  }
}
const tree = Bun.spawn(
  ["cargo", "tree", "-p", "xal-rust", "--edges", "normal", "--prefix", "none", "--locked", "--offline"],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
)
const dependencies = await new Response(tree.stdout).text()
if ((await tree.exited) !== 0) throw new Error("cargo tree failed")
if (/^(xal-native|napi|napi-derive|napi-build|ratatui|crossterm|wasmtime|wasmer) /m.test(dependencies))
  throw new Error("headless executable imports a legacy addon, terminal, or Wasm runtime")
console.log("Native plugin independence and headless dependency boundaries passed")
