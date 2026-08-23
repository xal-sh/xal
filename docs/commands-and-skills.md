# Commands and skills

Reuse common instructions through project guidance, lightweight Markdown prompt commands, or richer skill packages that the model loads on demand.

## Project instructions

Xal discovers `AGENTS.md` files and adds their guidance to the model prompt. `pluginConfig.project-instructions.maxBytes` controls the maximum combined UTF-8 byte budget for the discovered files. It must be a positive integer and defaults to `32768`.

```json
{
  "pluginConfig": {
    "project-instructions": {
      "maxBytes": 65536
    }
  }
}
```

## Prompt commands

Xal discovers reusable Markdown prompt commands from two directories:

| Scope   | Path                               | Priority |
| ------- | ---------------------------------- | -------- |
| User    | `<app-home>/commands/*.md`         | Lower    |
| Project | `<git-root>/.<name>/commands/*.md` | Higher   |

A project command replaces a user command with the same filename. Command filenames become slash-command names and must use lower-case letters, numbers, hyphens, or underscores. Prompt commands cannot replace built-in or plugin-registered commands.

Each file contains the prompt sent to the active session. Optional frontmatter supplies its command-palette description and argument hint:

```md
---
description: Review the current changes
argument-hint: <base-branch> [focus]
---

Review the current diff against $1. Pay particular attention to $2.

Additional context: $ARGUMENTS
```

`$1`, `$2`, and later numbered placeholders expand to positional arguments. `$ARGUMENTS` expands to all arguments joined with spaces, and `$$` emits a literal dollar sign. Missing positional arguments expand to an empty string.

After startup, type `/` in the TUI to see discovered commands in the command palette. Selecting one submits the expanded prompt through the same session path as a typed message.

## Skills

Xal discovers reusable skill packages from four directories, in increasing priority:

| Scope   | Path                                    |
| ------- | --------------------------------------- |
| User    | `~/.agents/skills/**/SKILL.md`          |
| User    | `<app-home>/skills/**/SKILL.md`         |
| Project | `<git-root>/.agents/skills/**/SKILL.md` |
| Project | `<git-root>/.<name>/skills/**/SKILL.md` |

A later package replaces an earlier package with the same skill name. Project skill directories are read only after workspace trust is established.

Every package is a directory named after its skill and containing a `SKILL.md` entry file. The entry file requires YAML frontmatter with a lower-case, hyphen-separated `name` and a `description`, followed by non-empty instructions:

```md
---
name: review-changes
description: Review the current workspace changes for correctness
---

Inspect the current diff, validate every finding, and report only actionable issues.
```

Only skill names and up to the first 160 characters of each normalized description enter the system prompt. Lead with concise matching criteria; put procedures and edge cases in the skill body. The model loads full instructions on demand with the read-only `skill` tool, which can also read referenced text files inside that package without allowing paths to escape the package directory. `SKILL.md` files are limited to 64 KiB and supporting files read through the tool are limited to 50,000 bytes.

Type `$` anywhere in the TUI composer to open skill completion. Continue typing to filter, then press Tab, Right, or Enter to replace only the skill reference at the cursor. Known `$skill-name` references are highlighted both while editing and in the submitted user message.

A prompt beginning with `$skill-name` explicitly invokes that skill. Xal keeps the compact original prompt visible in the conversation while sending the full skill instructions and the remaining user input to the model. A `$skill-name` reference later in a prompt remains ordinary user text, matching the behavior of other inline references. Skills do not register slash commands or appear in `/` completion.
