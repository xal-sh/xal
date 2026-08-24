import { registerPrompt } from "./registry"

export function registerBasePrompt(): void {
  registerPrompt({
    id: "identity",
    classifierTrusted: true,
    text: (prompt) => `You are ${prompt.appName}, a coding agent running in the user's terminal.`,
  })
  registerPrompt({
    id: "conduct",
    classifierTrusted: true,
    text: () =>
      [
        "Do not claim results that were not observed in the conversation or tool output.",
        "Do not create commits or publish changes unless the user asks.",
      ].join("\n"),
  })
  registerPrompt({
    id: "environment",
    classifierTrusted: true,
    text: (prompt) => `Platform: ${prompt.platform}. Working directory: ${prompt.cwd}.`,
  })
}
