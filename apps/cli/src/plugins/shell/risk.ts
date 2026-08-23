import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { commandSegments } from "./split"

const PATH_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "shred",
  "tee",
  "cd",
  "pushd",
])

const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "shred", "truncate"])

const WRAPPERS = new Set(["builtin", "command", "env", "exec", "nohup", "nice", "stdbuf", "time", "timeout"])

const SUPPORTED_SHELLS = new Set(["sh", "bash", "dash", "ksh", "mksh", "zsh"])

const SHELL_VALUE_OPTIONS = new Set(["-O", "+O", "-o", "+o", "--init-file", "--rcfile"])

const XARGS_VALUE_OPTIONS = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-J",
  "-L",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-R",
  "-S",
  "-s",
  "--max-chars",
])

const FIND_MUTATORS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"])

const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface Word {
  text: string
  dynamic: boolean
}

function readDoubleQuoted(segment: string, start: number, word: { text: string; dynamic: boolean }): number {
  let index = start
  while (index < segment.length) {
    const char = segment[index]!
    if (char === "\\") {
      word.text += segment[index + 1] ?? ""
      index += 2
      continue
    }
    if (char === '"') return index + 1
    if (char === "$" || char === "`") word.dynamic = true
    word.text += char
    index += 1
  }
  return index
}

function splitWords(segment: string): Word[] {
  const words: Word[] = []
  let current = { text: "", dynamic: false }
  let started = false
  let index = 0
  const push = (): void => {
    if (started) words.push(current)
    current = { text: "", dynamic: false }
    started = false
  }
  while (index < segment.length) {
    const char = segment[index]!
    if (char === " " || char === "\t") {
      push()
      index += 1
      continue
    }
    if (char === "\\" && segment[index + 1] === "\n") {
      index += 2
      continue
    }
    if (char === ">" || char === "<" || (char === "&" && segment[index + 1] === ">")) {
      const descriptor = started && /^\d+$/.test(current.text) ? current.text : ""
      if (descriptor) {
        current = { text: "", dynamic: false }
        started = false
      } else {
        push()
      }
      let operator = char
      let length = 1
      if (char === "&") {
        operator = "&>"
        length = 2
        if (segment[index + 2] === ">") {
          operator += ">"
          length += 1
        }
      } else if (
        segment[index + 1] === char ||
        (char === ">" && (segment[index + 1] === "|" || segment[index + 1] === "&")) ||
        (char === "<" && segment[index + 1] === ">")
      ) {
        operator += segment[index + 1]
        length = 2
      }
      words.push({ text: descriptor + operator, dynamic: false })
      index += length
      continue
    }
    started = true
    if (char === "\\") {
      current.text += segment[index + 1] ?? ""
      index += 2
      continue
    }
    if (char === "'") {
      const close = segment.indexOf("'", index + 1)
      const end = close < 0 ? segment.length : close
      current.text += segment.slice(index + 1, end)
      index = end + 1
      continue
    }
    if (char === '"') {
      index = readDoubleQuoted(segment, index + 1, current)
      continue
    }
    if (char === "$" || char === "`") current.dynamic = true
    current.text += char
    index += 1
  }
  push()
  return words
}

function extractRedirects(words: Word[]): { targets: Word[]; remaining: Word[] } {
  const targets: Word[] = []
  const remaining: Word[] = []
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    const operator = /^\d*(&>>?|>>&?|>&|>>?|>\||<>|<<?)$/.exec(word.text)?.[1]
    if (!operator) {
      remaining.push(word)
      index += 1
      continue
    }
    const target = words[index + 1]
    if (operator.includes(">") && target && !target.text.startsWith("&")) targets.push(target)
    index += target ? 2 : 1
  }
  return { targets, remaining }
}

interface CommandInvocation {
  name: Word
  args: Word[]
}

function commandAndArgs(words: Word[]): CommandInvocation | undefined {
  let index = 0
  while (index < words.length) {
    const text = words[index]!.text
    if (ASSIGNMENT.test(text) || text.startsWith("-") || /^\d+[smhd]?$/.test(text) || WRAPPERS.has(basename(text))) {
      index += 1
      continue
    }
    return { name: { ...words[index]!, text: basename(text) }, args: words.slice(index + 1) }
  }
  return undefined
}

function xargsCommand(words: Word[]): CommandInvocation | undefined {
  const start = words.findIndex((word) => basename(word.text) === "xargs")
  if (start < 0) return undefined
  let index = start + 1
  while (index < words.length) {
    const word = words[index]!
    if (word.text === "--") {
      index += 1
      break
    }
    if (!word.text.startsWith("-")) break
    if (XARGS_VALUE_OPTIONS.has(word.text)) index += 1
    index += 1
  }
  const command = words[index]
  if (!command) return undefined
  return { name: { ...command, text: basename(command.text) }, args: words.slice(index + 1) }
}

function commandCandidates(words: Word[]): CommandInvocation[] {
  const inspection = words.findIndex((word) => basename(word.text) === "command")
  if (inspection >= 0 && (words[inspection + 1]?.text === "-v" || words[inspection + 1]?.text === "-V")) return []
  const candidates = commandAndArgs(words)
  const xargs = xargsCommand(words)
  const xargsCandidates = xargs ? commandCandidates([xargs.name, ...xargs.args]) : []
  const first = words.findIndex((word) => !ASSIGNMENT.test(word.text) && !word.text.startsWith("-"))
  if (first < 0 || !WRAPPERS.has(basename(words[first]!.text))) {
    return candidates ? [candidates, ...xargsCandidates] : xargsCandidates
  }
  const possible = words.slice(first + 1).flatMap((word, index): CommandInvocation[] => {
    if (ASSIGNMENT.test(word.text) || word.text.startsWith("-") || /^\d+[smhd]?$/.test(word.text)) return []
    return [{ name: { ...word, text: basename(word.text) }, args: words.slice(first + index + 2) }]
  })
  possible.push(...xargsCandidates)
  if (!candidates) return possible
  return [candidates, ...possible.filter((candidate) => candidate.name.text !== candidates.name.text)]
}

interface EmbeddedCommands {
  segments: string[]
  unsafe: boolean
}

function commandStringOption(word: string): boolean {
  return word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes("c")
}

function groupedShellValueOptions(word: string): number {
  if ((!word.startsWith("-") && !word.startsWith("+")) || word.startsWith("--")) return 0
  return [...word.slice(1)].filter((option) => option === "O" || option === "o").length
}

function embeddedCommands(words: Word[]): EmbeddedCommands {
  const segments: string[] = []
  for (let index = 0; index < words.length; index++) {
    const name = basename(words[index]!.text)
    let script: Word | undefined
    if (name === "eval") {
      const args = words.slice(index + 1)
      if (args.some((arg) => arg.dynamic)) return { segments, unsafe: true }
      script = { text: args.map((arg) => arg.text).join(" "), dynamic: false }
    } else if (SUPPORTED_SHELLS.has(name)) {
      for (let option = index + 1; option < words.length; option++) {
        const word = words[option]!
        if (!commandStringOption(word.text)) continue
        let operand = option + 1
        const groupedValues = groupedShellValueOptions(word.text)
        if (groupedValues > 0 && !words[operand + groupedValues - 1]) return { segments, unsafe: true }
        operand += groupedValues
        while (operand < words.length) {
          const candidate = words[operand]!.text
          if (candidate === "--") {
            operand += 1
            break
          }
          if (SHELL_VALUE_OPTIONS.has(candidate)) {
            if (!words[operand + 1]) return { segments, unsafe: true }
            operand += 2
            continue
          }
          if (candidate.startsWith("--init-file=") || candidate.startsWith("--rcfile=")) {
            operand += 1
            continue
          }
          if (candidate.startsWith("--")) return { segments, unsafe: true }
          if (!candidate.startsWith("-") && !candidate.startsWith("+")) break
          const candidateValues = groupedShellValueOptions(candidate)
          if (!words[operand + candidateValues]) return { segments, unsafe: true }
          operand += candidateValues + 1
        }
        script = words[operand]
        if (!script) return { segments, unsafe: true }
        break
      }
    }
    if (!script) continue
    if (script.dynamic) return { segments, unsafe: true }
    const parsed = commandSegments(script.text)
    if (!parsed) return { segments, unsafe: true }
    segments.push(...parsed)
  }
  return { segments, unsafe: false }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function escapes(word: Word, cwd: string, destructive: boolean): boolean {
  if (word.dynamic) return true
  const text = word.text
  if (!text || text === "{}" || text === ";" || text === "+") return false
  const expanded = text === "~" || text.startsWith("~/") ? join(homedir(), text.slice(1)) : text
  if (expanded.startsWith("~")) return true
  const absolute = resolve(cwd, expanded)
  if (DEVICES.has(absolute)) return false
  if (inside(absolute, cwd)) {
    if (!destructive) return false
    const rel = relative(cwd, absolute)
    return rel === "" || rel === ".git" || rel.startsWith(".git/")
  }
  return !inside(absolute, tmpdir()) && !inside(absolute, "/tmp")
}

function wrapperEscapes(words: Word[], cwd: string): boolean {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (word.text === "-C" || word.text === "--chdir") {
      const path = words[index + 1]
      if (!path || escapes(path, cwd, false)) return true
    }
    if (word.text.startsWith("-C") && word.text.length > 2) {
      const path = { ...word, text: word.text.slice(2) }
      if (escapes(path, cwd, false)) return true
    }
    if (word.text.startsWith("--chdir=")) {
      const path = { ...word, text: word.text.slice("--chdir=".length) }
      if (escapes(path, cwd, false)) return true
    }
    if (word.text === "-S" || word.text.startsWith("-S") || word.text.startsWith("--split-string")) return true
  }
  return false
}

export function commandSubjects(segment: string): string[] {
  const { remaining } = extractRedirects(splitWords(segment))
  const direct = commandCandidates(remaining).map((candidate) =>
    [candidate.name.text, ...candidate.args.map((arg) => arg.text)].join(" "),
  )
  const embedded = embeddedCommands(remaining).segments.flatMap((nested) => [nested, ...commandSubjects(nested)])
  return [...new Set([...direct, ...embedded])]
}

function invocationEscapes(invocation: CommandInvocation, cwd: string): boolean {
  const { name, args } = invocation
  if (name.dynamic) return true
  if (SUPPORTED_SHELLS.has(name.text)) {
    if (args.some((arg) => commandStringOption(arg.text))) return false
    const script = args.find((arg) => !arg.text.startsWith("-"))
    return !script || escapes(script, cwd, false)
  }
  if (name.text === "xargs") return args.some((arg) => DESTRUCTIVE.has(basename(arg.text)))
  if (name.text === "find") {
    if (!args.some((arg) => FIND_MUTATORS.has(arg.text))) return false
    const roots: Word[] = []
    for (const arg of args) {
      if (arg.text.startsWith("-")) break
      roots.push(arg)
    }
    if (roots.length === 0) return true
    return roots.some((root) => escapes(root, cwd, true))
  }
  if (!PATH_COMMANDS.has(name.text)) return false
  const destructive = DESTRUCTIVE.has(name.text)
  return args.some((arg) => !arg.text.startsWith("-") && escapes(arg, cwd, destructive))
}

export function commandEscapesWorkspace(segment: string, cwd: string): boolean {
  const words = splitWords(segment)
  const { targets, remaining } = extractRedirects(words)
  if (words.some((word) => word.text.startsWith("CDPATH="))) return true
  if (targets.some((target) => escapes(target, cwd, false))) return true
  if (wrapperEscapes(remaining, cwd)) return true
  const embedded = embeddedCommands(remaining)
  if (embedded.unsafe || embedded.segments.some((nested) => commandEscapesWorkspace(nested, cwd))) return true
  return commandCandidates(remaining).some((candidate) => invocationEscapes(candidate, cwd))
}
