function readSingleQuoted(command: string, start: number): { text: string; end: number } {
  const close = command.indexOf("'", start + 1)
  if (close < 0) return { text: command.slice(start), end: command.length }
  return { text: command.slice(start, close + 1), end: close + 1 }
}

function readDoubleQuoted(command: string, start: number): { text: string; end: number } | undefined {
  let index = start + 1
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "`") return undefined
    if (char === "$" && command[index + 1] === "(") return undefined
    if (char === '"') return { text: command.slice(start, index + 1), end: index + 1 }
    index += 1
  }
  return undefined
}

export function splitCommand(command: string): string[] | undefined {
  const segments: string[] = []
  let current = ""
  let index = 0
  const push = (): void => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ""
  }
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      current += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === "'") {
      if (command.indexOf("'", index + 1) < 0) return undefined
      const quoted = readSingleQuoted(command, index)
      current += quoted.text
      index = quoted.end
      continue
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(command, index)
      if (!quoted) return undefined
      current += quoted.text
      index = quoted.end
      continue
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(")) return undefined
    if (char === "(" || char === ")" || char === "{" || char === "}") return undefined
    if (char === "&" && command[index + 1] === "&") {
      push()
      index += 2
      continue
    }
    if (char === "&" && command[index + 1] === ">") {
      current += "&>"
      index += 2
      continue
    }
    if (char === "&" && command[index - 1] === ">") {
      current += char
      index += 1
      continue
    }
    if (char === "|" && current.endsWith(">")) {
      current += char
      index += 1
      continue
    }
    if (char === "&") return undefined
    if (char === "|" || char === ";" || char === "\n") {
      push()
      index += char === "|" && command[index + 1] === "|" ? 2 : 1
      continue
    }
    current += char
    index += 1
  }
  push()
  if (segments.length === 0) return undefined
  return segments
}

interface CompoundResult {
  segments: string[]
  end: number
}

function controlBody(segment: string): string {
  let body = segment.trim()
  while (true) {
    const match = /^(?:!\s*|(?:if|then|elif|else|while|until|do)\b\s*)/.exec(body)
    if (!match) return body
    body = body.slice(match[0].length).trimStart()
  }
}

function standaloneBrace(command: string, index: number): boolean {
  const boundary = (char: string | undefined): boolean => char === undefined || /[\s;&|()]/.test(char)
  return boundary(command[index - 1]) && boundary(command[index + 1])
}

interface HereDoc {
  delimiter: string
  expand: boolean
  stripTabs: boolean
  text: string
}

function hereDocAt(command: string, index: number): HereDoc | undefined {
  const match = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/.exec(command.slice(index))
  if (!match) return undefined
  const delimiter = match[2] ?? match[3] ?? match[4]
  if (!delimiter) return undefined
  return { delimiter, expand: match[4] !== undefined, stripTabs: match[1] === "-", text: match[0] }
}

function skipHereDocs(
  command: string,
  start: number,
  hereDocs: HereDoc[],
  executeBodies: boolean,
): CompoundResult | undefined {
  const segments: string[] = []
  let index = start
  for (const hereDoc of hereDocs) {
    let body = ""
    let found = false
    while (index <= command.length) {
      const lineEnd = command.indexOf("\n", index)
      const end = lineEnd < 0 ? command.length : lineEnd
      const line = command.slice(index, end)
      const compared = hereDoc.stripTabs ? line.replace(/^\t+/, "") : line
      index = lineEnd < 0 ? end : end + 1
      if (compared !== hereDoc.delimiter) {
        body += `${line}\n`
        if (lineEnd < 0) break
        continue
      }
      found = true
      break
    }
    if (!found) return undefined
    if (executeBodies && body.trim()) {
      const executed = readCompound(body, 0)
      if (!executed) return undefined
      segments.push(...executed.segments)
    } else if (hereDoc.expand) {
      const expanded = readExpansions(body)
      if (!expanded) return undefined
      segments.push(...expanded)
    }
  }
  return { segments, end: index }
}

interface CompoundQuotedResult extends CompoundResult {
  text: string
}

function zshSubstitutionAt(command: string, index: number): boolean {
  return command[index] === "$" && command[index + 1] === "{" && /[\s|]/.test(command[index + 2] ?? "")
}

function readArithmetic(command: string, start: number): CompoundResult | undefined {
  const segments: string[] = []
  let depth = 1
  let index = start
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "'") {
      const quoted = readSingleQuoted(command, index)
      index = quoted.end
      continue
    }
    if (char === '"') {
      const quoted = readCompoundDoubleQuoted(command, index)
      if (!quoted) return undefined
      segments.push(...quoted.segments)
      index = quoted.end
      continue
    }
    if (zshSubstitutionAt(command, index)) {
      const nested = readCompound(command, index + 2, "}")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      const nested = readCompound(command, index + 2, ")")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === "`") {
      const nested = readCompound(command, index + 1, "`")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === "(") depth += 1
    if (char === ")") {
      if (depth === 1 && command[index + 1] === ")") return { segments, end: index + 2 }
      depth -= 1
      if (depth < 1) return undefined
    }
    index += 1
  }
  return undefined
}

function readExpansions(text: string): string[] | undefined {
  const segments: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (zshSubstitutionAt(text, index)) {
      const nested = readCompound(text, index + 2, "}")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === "$" && text[index + 1] === "(" && text[index + 2] === "(") {
      const arithmetic = readArithmetic(text, index + 3)
      if (!arithmetic) return undefined
      segments.push(...arithmetic.segments)
      index = arithmetic.end
      continue
    }
    if (char === "$" && text[index + 1] === "(") {
      const nested = readCompound(text, index + 2, ")")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === "`") {
      const nested = readCompound(text, index + 1, "`")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    index += 1
  }
  return segments
}

function readCompoundDoubleQuoted(command: string, start: number): CompoundQuotedResult | undefined {
  const segments: string[] = []
  let text = '"'
  let index = start + 1
  while (index < command.length) {
    const char = command[index]!
    if (char === "\\") {
      if (command[index + 1] !== "\n") text += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '"') return { segments, text: `${text}"`, end: index + 1 }
    if (zshSubstitutionAt(command, index)) {
      const nested = readCompound(command, index + 2, "}")
      if (!nested) return undefined
      segments.push(...nested.segments)
      text += "$()"
      index = nested.end
      continue
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      const arithmetic = readArithmetic(command, index + 3)
      if (!arithmetic) return undefined
      segments.push(...arithmetic.segments)
      text += "$()"
      index = arithmetic.end
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      const nested = readCompound(command, index + 2, ")")
      if (!nested) return undefined
      segments.push(...nested.segments)
      text += "$()"
      index = nested.end
      continue
    }
    if (char === "`") {
      const nested = readCompound(command, index + 1, "`")
      if (!nested) return undefined
      segments.push(...nested.segments)
      text += "$()"
      index = nested.end
      continue
    }
    text += char
    index += 1
  }
  return undefined
}

function shellReadsHereDoc(segment: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]+\/)?(?:sh|bash|dash|ksh|mksh|zsh)(?=$|[\s<>;&|])/.test(segment)
}

function readCompound(command: string, start: number, terminator?: ")" | "`" | "}"): CompoundResult | undefined {
  const segments: string[] = []
  const hereDocs: HereDoc[] = []
  let caseDepth = 0
  let unsupported = false
  let current = ""
  let index = start
  const push = (): void => {
    const segment = controlBody(current)
    if (/^case\b[\s\S]*\bin\b/.test(segment)) caseDepth += 1
    else if (/^esac\b/.test(segment) && caseDepth > 0) caseDepth -= 1
    if (/^coproc\b/.test(segment)) unsupported = true
    if (segment) segments.push(segment)
    current = ""
  }
  while (index < command.length) {
    const char = command[index]!
    if (char === terminator) {
      const body = controlBody(current)
      const casePattern = /^case\b[\s\S]*\bin\b/.test(body) || (caseDepth > 0 && !/^esac\b/.test(body))
      if (terminator === ")" && casePattern) {
        push()
        index += 1
        continue
      }
      if (hereDocs.length > 0) return undefined
      push()
      if (caseDepth > 0 || unsupported) return undefined
      return { segments, end: index + 1 }
    }
    if (char === "\\") {
      if (command[index + 1] !== "\n") current += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === "<") {
      const hereDoc = hereDocAt(command, index)
      if (hereDoc) {
        hereDocs.push(hereDoc)
        current += hereDoc.text
        index += hereDoc.text.length
        continue
      }
    }
    if (char === "'") {
      if (command.indexOf("'", index + 1) < 0) return undefined
      const quoted = readSingleQuoted(command, index)
      current += quoted.text
      index = quoted.end
      continue
    }
    if (char === '"') {
      const quoted = readCompoundDoubleQuoted(command, index)
      if (!quoted) return undefined
      segments.push(...quoted.segments)
      current += quoted.text
      index = quoted.end
      continue
    }
    if (zshSubstitutionAt(command, index)) {
      const nested = readCompound(command, index + 2, "}")
      if (!nested) return undefined
      segments.push(...nested.segments)
      current += "$()"
      index = nested.end
      continue
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      const arithmetic = readArithmetic(command, index + 3)
      if (!arithmetic) return undefined
      segments.push(...arithmetic.segments)
      current += "$()"
      index = arithmetic.end
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      const nested = readCompound(command, index + 2, ")")
      if (!nested) return undefined
      segments.push(...nested.segments)
      current += "$()"
      index = nested.end
      continue
    }
    if (char === "`") {
      const nested = readCompound(command, index + 1, "`")
      if (!nested) return undefined
      segments.push(...nested.segments)
      current += "$()"
      index = nested.end
      continue
    }
    if (char === "(") {
      push()
      const nested = readCompound(command, index + 1, ")")
      if (!nested) return undefined
      segments.push(...nested.segments)
      index = nested.end
      continue
    }
    if (char === ")") {
      push()
      index += 1
      continue
    }
    if ((char === "{" || char === "}") && standaloneBrace(command, index)) {
      push()
      index += 1
      continue
    }
    if (char === "&" && (command[index + 1] === ">" || command[index - 1] === ">")) {
      current += char
      index += 1
      continue
    }
    if (char === "&" && command[index + 1] !== "&") return undefined
    if (char === "|" && current.endsWith(">")) {
      current += char
      index += 1
      continue
    }
    if (char === "\n" && hereDocs.length > 0) {
      const executeBodies = shellReadsHereDoc(current)
      push()
      const skipped = skipHereDocs(command, index + 1, hereDocs, executeBodies)
      if (!skipped) return undefined
      segments.push(...skipped.segments)
      hereDocs.length = 0
      index = skipped.end
      continue
    }
    if (char === "&" || char === "|" || char === ";" || char === "\n") {
      push()
      index += (char === "&" || char === "|") && command[index + 1] === char ? 2 : 1
      continue
    }
    current += char
    index += 1
  }
  if (terminator || hereDocs.length > 0) return undefined
  push()
  if (caseDepth > 0 || unsupported) return undefined
  return segments.length === 0 ? undefined : { segments, end: index }
}

export function commandSegments(command: string): string[] | undefined {
  const segments = readCompound(command, 0)?.segments
  if (!segments) return undefined
  const normalized = segments.map(controlBody).filter(Boolean)
  return normalized.length === 0 ? undefined : normalized
}

export function isAssignmentPrefix(input: string): boolean {
  return input.startsWith("=") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(input)
}

const CONTROL_KEYWORDS = new Set([
  "coproc",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "for",
  "select",
  "function",
  "case",
  "time",
])

function isControlPrefix(prefix: string): boolean {
  const first = prefix.split(/\s+/)[0]!
  if (first === "!" || CONTROL_KEYWORDS.has(first)) return true
  return /^(?:coproc|if|then|elif|else|while|until|do|for|select|function|case)\b/.test(prefix)
}

export function commandPrefix(command: string): { prefix: string; rest: string } | undefined {
  const segments = splitCommand(command)
  if (!segments || segments.length === 0) return undefined
  const prefix = segments[0]!.trim()
  if (prefix.includes("$()")) return undefined
  if (isAssignmentPrefix(prefix)) return undefined
  if (isControlPrefix(prefix)) return undefined
  if (prefix.split(/\s+/).length < 2) return undefined
  return { prefix, rest: segments.slice(1).join(" && ") }
}
