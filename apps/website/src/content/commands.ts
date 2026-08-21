import { isTheme, setTheme, storedTheme, THEMES } from "../theme.ts"
import type { Block } from "../tui/blocks.ts"
import type { PermissionChoice } from "../tui/permission.ts"
import * as content from "./sections.ts"

export type CommandContext = {
  print(...blocks: Block[]): Promise<void>
  replaceLast(block: Block): void
  reset(): void
  ask(choices: PermissionChoice[]): Promise<PermissionChoice>
  open(url: string): void
  visit(url: string): void
}

export type Command = {
  name: string
  describe: string
  routable?: boolean
  route?: string
  run(context: CommandContext, args: string): Promise<void>
}

const INSTALL_CHOICES: PermissionChoice[] = [
  { key: "y", text: "Allow once", allow: true },
  { key: "s", text: "Allow bash(curl*) this session", allow: true },
  { key: "a", text: "Always allow bash(curl*)", allow: true },
  { key: "n", text: "Deny", allow: false },
]

export const commands: Command[] = [
  {
    name: "/about",
    routable: true,
    describe: "what xal is",
    run: (context) => context.print(...content.about),
  },
  {
    name: "/tools",
    routable: true,
    describe: "what the agent can actually do",
    run: (context) => context.print(...content.tools),
  },
  {
    name: "/safety",
    routable: true,
    describe: "permissions, plan mode, redaction, undo",
    run: (context) => context.print(...content.safety),
  },
  {
    name: "/plugins",
    routable: true,
    describe: "the small core and everything around it",
    run: (context) => context.print(...content.plugins),
  },
  {
    name: "/agents",
    routable: true,
    describe: "sub-agents, background jobs, sessions",
    run: (context) => context.print(...content.agents),
  },
  {
    name: "/contact",
    routable: true,
    describe: "official support and contact channels",
    run: (context) => context.print(...content.contact),
  },
  {
    name: "/privacy",
    routable: true,
    describe: "website and application privacy practices",
    run: (context) => context.print(...content.privacy),
  },
  {
    name: "/developers",
    routable: true,
    describe: "API, OpenAPI, CLI, plugins, and MCP",
    run: (context) => context.print(...content.developers),
  },
  {
    name: "/cli",
    routable: true,
    describe: "official Xal command-line tool",
    run: (context) => context.print(...content.cli),
  },
  {
    name: "/mcp",
    routable: true,
    describe: "connect Xal to MCP servers",
    run: (context) => context.print(...content.mcp),
  },
  {
    name: "/install",
    routable: true,
    route: "/get",
    describe: "one binary, no runtime",
    run: async (context) => {
      await context.print(content.installIntro, content.installPending)
      const choice = await context.ask(INSTALL_CHOICES)
      const [settled, ...rest] = choice.allow ? content.installAllowed : content.installDenied
      if (settled) context.replaceLast(settled)
      await context.print(...rest)
    },
  },
  {
    name: "/docs",
    describe: "open the configuration reference",
    run: async (context) => {
      await context.print({ kind: "info", text: `opening ${content.DOCS_PATH} …` })
      context.visit(content.DOCS_PATH)
    },
  },
  {
    name: "/github",
    describe: "open the repository",
    run: async (context) => {
      context.open(content.REPOSITORY)
      await context.print({ kind: "info", text: `opening ${content.REPOSITORY}` })
    },
  },
  {
    name: "/theme",
    describe: `switch the palette · ${THEMES.join(" | ")}`,
    run: async (context, args) => {
      const requested = args.trim().toLowerCase()
      if (!requested) {
        await context.print({
          kind: "doc",
          nodes: [
            { kind: "paragraph", text: `Theme is \`${storedTheme()}\`. Pass one of:` },
            { kind: "list", items: THEMES.map((theme) => `\`/theme ${theme}\``) },
          ],
        })
        return
      }
      if (!isTheme(requested)) {
        await context.print({ kind: "info", text: `unknown theme \`${requested}\` — use ${THEMES.join(", ")}` })
        return
      }
      setTheme(requested)
      await context.print({ kind: "info", text: `theme set to \`${requested}\`` })
    },
  },
  {
    name: "/help",
    routable: true,
    describe: "list every command",
    run: (context) =>
      context.print({
        kind: "doc",
        nodes: [
          { kind: "heading", text: "Commands" },
          { kind: "list", items: commands.map((command) => `\`${command.name}\` — ${command.describe}`) },
          {
            kind: "paragraph",
            text: "`↑` `↓` browse history · `Tab` complete · `Esc` clear the input. This page is a small emulation of the real thing — install it to get the rest.",
          },
        ],
      }),
  },
  {
    name: "/clear",
    describe: "start a new session",
    run: async (context) => {
      context.reset()
      await context.print(...content.session)
    },
  },
]

export function findCommand(input: string): Command | undefined {
  const name = input.split(/\s+/)[0]?.toLowerCase()
  return commands.find((command) => command.name === name)
}

export function findRoutedCommand(path: string): Command | undefined {
  return commands.find((command) => command.routable && (command.route ?? command.name) === path)
}
