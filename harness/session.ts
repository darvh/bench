import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-session view: what actually happened in each trial — step by step.
 * Reads results/<runId>/sessions/<id>/<trial>/trajectory.json.
 *
 *   bun run harness/session.ts [results/<runId>] [--verbose]
 */

const runDir = process.argv[2] ?? path.join(import.meta.dir, "..", "results");
const verbose = process.argv.includes("--verbose");

interface ToolCall {
  function_name: string;
  arguments?: Record<string, unknown>;
}
interface Step {
  step_id: number;
  source: string;
  timestamp?: string;
  message?: string;
  tool_calls?: ToolCall[];
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cost_usd?: number };
}

function walkSessions(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSafe(d)) {
      const p = path.join(d, e);
      if (isDir(p)) walk(p);
      else if (e === "trajectory.json") out.push(p);
    }
  };
  walk(dir);
  return out;
}
const readdirSafe = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
const isDir = (p: string): boolean => statSafe(p).isDirectory();
const statSafe = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return { isDirectory: () => false };
  }
};
import { readdirSync, statSync } from "node:fs";

const files = walkSessions(runDir);
if (!files.length) {
  console.error(`no sessions under ${runDir} (run results/<runId> first)`);
  process.exit(1);
}

for (const f of files.sort()) {
  const rel = path.relative(runDir, f);
  const d = JSON.parse(readFileSync(f, "utf8")) as { steps?: Step[]; final_metrics?: Record<string, number> };
  const steps = d.steps ?? [];
  console.log(`\n== ${rel.split("/").slice(0, 2).join("/")}`);
  for (const s of steps) {
    const tools = (s.tool_calls ?? []).map((t) => {
      const a = t.arguments ? " " + JSON.stringify(t.arguments).slice(0, 80) : "";
      return `${t.function_name}${a}`;
    });
    const m = s.metrics;
    const toks = m ? ` [${m.prompt_tokens ?? 0}+${m.completion_tokens ?? 0} tok $${(m.cost_usd ?? 0).toFixed(6)}]` : "";
    const msg = (s.message ?? "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  #${s.step_id} ${s.source}${toks}${tools.length ? "\n      tools: " + tools.join("\n      tools: ") : ""}${msg && verbose ? "\n      msg: " + msg : ""}`);
  }
  const fm = d.final_metrics;
  if (fm) console.log(`  final: ${fm.total_steps ?? "?"} steps, ${fm.total_prompt_tokens ?? 0} in, ${fm.total_completion_tokens ?? 0} out, $${(fm.total_cost_usd ?? 0).toFixed(6)}`);
}
