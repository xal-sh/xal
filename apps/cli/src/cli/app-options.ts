export interface AppOptions {
  profile: boolean
  mode?: string
  args: string[]
}

function optionValue(input: string[], index: number, option: string): string {
  const value = input[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`${option} expects a value`)
  return value
}

export function parseAppOptions(input: string[]): AppOptions {
  let profile = false
  let mode: string | undefined
  let index = 0

  while (input[index]?.startsWith("-")) {
    const option = input[index]!
    if (option === "--profile") {
      if (profile) throw new Error("duplicate option: --profile")
      profile = true
      index++
      continue
    }
    if (option === "--mode") {
      if (mode !== undefined) throw new Error("duplicate option: --mode")
      mode = optionValue(input, index, option)
      index += 2
      continue
    }
    break
  }

  return { profile, mode, args: input.slice(index) }
}
