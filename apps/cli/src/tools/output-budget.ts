import { boundToolOutput, unsavedToolOutput } from "./output"
import type { ToolResult } from "./types"

export class ToolOutputBudget {
  constructor(
    frozenOutputs: string[] = [],
    private remaining = 200 * 1024,
  ) {
    for (const output of frozenOutputs) this.remaining = Math.max(0, this.remaining - Buffer.byteLength(output))
  }

  async apply(directory: string, results: Pick<ToolResult, "output" | "outputSaved">[]): Promise<string[]> {
    const outputs = results.map((result) => result.output)
    const bounded = [...outputs]
    const sizes = outputs.map((output) => Buffer.byteLength(output))
    let total = sizes.reduce((sum, size) => sum + size, 0)
    const largest = sizes.map((size, index) => ({ size, index })).sort((a, b) => b.size - a.size || a.index - b.index)
    for (const { size, index } of largest) {
      if (total <= this.remaining) break
      if (size <= 2048) continue
      try {
        bounded[index] = await boundToolOutput(directory, outputs[index]!, 2048, results[index]!.outputSaved)
      } catch (error) {
        bounded[index] = unsavedToolOutput(outputs[index]!, error, 2048)
      }
      total += Buffer.byteLength(bounded[index]!) - size
    }
    this.remaining = Math.max(0, this.remaining - total)
    return bounded
  }
}
