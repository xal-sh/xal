import { registerPrompt } from "./registry"

export function registerBasePrompt(): void {
  registerPrompt({
    id: "identity",
    text: (prompt) => `You are ${prompt.appName}, a coding agent running in the user's terminal.`,
  })
  registerPrompt({
    id: "conduct",
    text: () =>
      [
        "Tool calls may require the user's approval before they run. If the user denies an action, respect the denial and adjust your approach instead of retrying the same action.",
        "Do not claim results that were not observed in the conversation or tool output.",
        "Do not create commits or publish changes unless the user asks.",
      ].join("\n"),
  })
  registerPrompt({
    id: "environment",
    text: (prompt) => `Platform: ${prompt.platform}. Working directory: ${prompt.cwd}.`,
  })
}
