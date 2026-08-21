import { Glob } from "bun"
import { toDocument, type Document } from "./render.ts"

const SOURCE = new URL("../../../../docs/", import.meta.url)

export async function loadDocuments(): Promise<Document[]> {
  const order = new Map(
    [
      "install",
      "configs",
      "tui",
      "permissions",
      "providers",
      "integrations",
      "api",
      "plugins",
      "commands-and-skills",
      "goals",
      "scheduler",
      "background-work",
    ].map((slug, index) => [slug, index]),
  )
  const files = [...new Glob("*.md").scanSync(Bun.fileURLToPath(SOURCE))].sort((left, right) => {
    const leftOrder = order.get(left.replace(/\.md$/, "")) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right.replace(/\.md$/, "")) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.localeCompare(right)
  })
  if (files.length === 0) throw new Error(`no markdown found in ${Bun.fileURLToPath(SOURCE)}`)

  const documents: Document[] = []
  for (const file of files) {
    const source = await Bun.file(new URL(file, SOURCE)).text()
    documents.push(toDocument(file.replace(/\.md$/, ""), source))
  }
  return documents
}
