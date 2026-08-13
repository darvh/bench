// @ts-nocheck — loaded at runtime by pi in the container; dep is global, not local
// Bench pi extension — caps large tool results before they reach the model.
// pi's extension runner applies changes via the handler's RETURN value (in-place
// mutation does not propagate). Hook "tool_result" and return capped content.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MAX_CHARS = Number(process.env.BENCH_MAX_TOOL_OUTPUT || 8000)

export default async function (pi: ExtensionAPI) {
  pi.on("tool_result", (event: any) => {
    try {
      if (!event?.content || !Array.isArray(event.content)) return null
      let changed = false
      const content = event.content.map((p: any) => {
        if (p?.type === "text" && typeof p.text === "string" && p.text.length > MAX_CHARS) {
          changed = true
          return { ...p, text: p.text.slice(0, MAX_CHARS) + "\n…[truncated by bench]" }
        }
        return p
      })
      return changed ? { content } : null
    } catch {
      return null
    }
  })
}
