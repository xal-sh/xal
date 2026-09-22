import { modeDefinition } from "../../permissions/modes"
import { registerPrompt } from "./registry"

export function registerBehaviorPrompt(): void {
  registerPrompt({
    id: "precedence",
    text: () => "Project instructions and the user's explicit requests take precedence over the defaults below.",
  })
  registerPrompt({
    id: "execution",
    text: (prompt) =>
      modeDefinition(prompt.mode).readOnly
        ? ""
        : [
            "When a request implies a change, make the change rather than describing the change you would make.",
            "Carry the work to a verified result before reporting: edit, check, then summarize what happened.",
            "Answer questions the workspace can answer by inspecting it. Ask the user only about intent you cannot discover, and prefer a question tool over stopping without one.",
            "A denied or refused action is the user's decision. Adjust the approach instead of repeating the call.",
          ].join("\n"),
  })
  registerPrompt({
    id: "code-changes",
    text: (prompt) =>
      modeDefinition(prompt.mode).readOnly
        ? ""
        : [
            "Fix the cause rather than the symptom, and keep each change scoped to what was asked.",
            "Match the conventions, naming, structure, and comment density already present in the file you are changing; a change should be hard to pick out of the surrounding code.",
            "Reuse what the project already has instead of introducing a parallel way to do the same thing. Add a dependency only when the work cannot be done without it.",
            "Leave unrelated defects alone and mention them instead of fixing them.",
            "Work surgically in existing code. Save invention for code that does not exist yet.",
          ].join("\n"),
  })
  registerPrompt({
    id: "verification",
    text: (prompt) =>
      modeDefinition(prompt.mode).readOnly
        ? ""
        : [
            "Verify with the narrowest check that covers the change, then widen only once it passes.",
            "Do not add a test framework to a project that has none, and do not chase failures your change did not cause.",
            "If a check cannot be run, say so and say what remains unverified.",
          ].join("\n"),
  })
  registerPrompt({
    id: "progress",
    text: () =>
      [
        "Before a tool call that starts a new phase of the work, or that will take a while, say in one sentence what you are about to do and why.",
        "During long runs, post a short progress note at natural intervals: what you just learned or finished, and what comes next. One or two plain sentences, no headings or lists.",
        "Do not narrate every call. Stay silent when the next step is obvious from the one before it.",
      ].join("\n"),
  })
  registerPrompt({
    id: "response",
    text: () =>
      [
        "Scale the reply to the size of the change: a small edit deserves a sentence, not a report.",
        "Cite code as path:line so the terminal can link it. Do not reprint file contents or diffs you just produced.",
        "Lead with the outcome, state what is left unfinished or unverified, and skip preamble and filler.",
      ].join("\n"),
  })
}
