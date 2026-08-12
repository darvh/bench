import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Local trajectory visualizer: renders every trial's steps (tools, args,
 * observations, tokens, cost) as a self-contained HTML file, no network.
 *
 *   bun run harness/viz.ts [results/<runId>]     -> results/<runId>/trajectory.html
 */

const resultsRoot = path.join(import.meta.dir, "..", "results");
const runDir = process.argv[2] ?? newestRunDir(resultsRoot);

function newestRunDir(root: string): string {
  const dirs = readdirSafe(root).filter((d) => statSafe(path.join(root, d)).isDirectory());
  return path.join(root, dirs.sort().at(-1) ?? "");
}

const readdirSafe = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const statSafe = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return { isDirectory: () => false };
  }
};
import { readdirSync, statSync } from "node:fs";

interface Trial {
  id: string;
  name: string;
  steps: Step[];
  final?: Record<string, number>;
}
interface Step {
  step_id: number;
  source: string;
  timestamp?: string;
  message?: string;
  tool_calls?: { function_name: string; arguments?: Record<string, unknown> }[];
  observation?: { results?: { source_call_id?: string; content?: string }[] };
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cost_usd?: number };
}

const trials: Trial[] = [];
for (const cell of readdirSafe(path.join(runDir, "sessions"))) {
  const cellDir = path.join(runDir, "sessions", cell);
  for (const trialDir of readdirSafe(cellDir)) {
    const t = path.join(cellDir, trialDir, "trajectory.json");
    if (!isFile(t)) continue;
    const d = JSON.parse(readFileSync(t, "utf8")) as { steps?: Step[]; final_metrics?: Record<string, number> };
    trials.push({ id: cell, name: trialDir, steps: d.steps ?? [], final: d.final_metrics });
  }
}
if (!trials.length) {
  console.error(`no sessions under ${runDir}`);
  process.exit(1);
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const stepHtml = (s: Step, i: number): string => {
  const m = s.metrics ?? {};
  const toks = `${m.prompt_tokens ?? 0}in/${m.completion_tokens ?? 0}out`;
  const cost = `$${(m.cost_usd ?? 0).toFixed(6)}`;
  const time = (s.timestamp ?? "").slice(11, 19);
  const tools = (s.tool_calls ?? [])
    .map((t, j) => {
      const isSkill = t.function_name === "skill";
      const args = t.arguments ? esc(JSON.stringify(t.arguments, null, 1)) : "";
      const obs = s.observation?.results?.[j]?.content ? esc(s.observation.results[j].content).slice(0, 4000) : "";
      return `<details class="tool ${isSkill ? "skill" : ""}" ${i === 1 && j === 0 && isSkill ? "open" : ""}>
        <summary>${isSkill ? "★ " : ""}${esc(t.function_name)}${t.arguments ? " — " + esc(JSON.stringify(t.arguments)).slice(0, 120) : ""}</summary>
        ${args ? `<pre>${args}</pre>` : ""}
        ${obs ? `<pre class="obs">${obs}${obs.length >= 4000 ? "\n…(truncated)" : ""}</pre>` : ""}
      </details>`;
    })
    .join("");
  const msg = s.message ? `<details><summary>message</summary><pre>${esc(s.message)}</pre></details>` : "";
  return `<div class="step ${s.source === "user" ? "user" : ""}">
    <div class="stephead">#${s.step_id} ${s.source} ${time} <span class="toks">${toks} ${cost}</span></div>
    ${tools}${msg}
  </div>`;
};

const cards = trials
  .map(
    (t) => `<section class="card">
    <h3>${esc(t.id)} <small>${esc(t.name)}</small></h3>
    ${t.final ? `<div class="final">${esc(t.final.total_steps ?? 0)} steps · ${esc(t.final.total_prompt_tokens ?? 0)} in · ${esc(t.final.total_completion_tokens ?? 0)} out · $${Number(t.final.total_cost_usd ?? 0).toFixed(6)}</div>` : ""}
    ${t.steps.map(stepHtml).join("")}
  </section>`,
  )
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>trajectories — ${path.basename(runDir)}</title>
<style>
body{font:13px/1.45 ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9;margin:24px}
h1{font-size:16px;color:#58a6ff}h3{margin:0 0 6px;color:#e6edf3}h3 small{color:#8b949e;font-weight:normal}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;margin:16px 0}
.final{color:#8b949e;margin-bottom:10px}
.step{border-left:2px solid #30363d;padding:6px 10px;margin:4px 0}
.step.user{border-left-color:#1f6feb}
.stephead{color:#8b949e}
.toks{float:right;color:#8b949e}
.tool{margin:4px 0 4px 12px;border:1px solid #30363d;border-radius:6px;padding:2px 8px}
.tool.skill{border-color:#238636;background:#12261a}
.tool summary{cursor:pointer;color:#e6edf3}
pre{background:#0d1117;border-radius:6px;padding:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;color:#a5d6a7}
pre.obs{color:#d2a8ff}
</style></head><body>
<h1>trajectories — ${esc(path.basename(runDir))} (${trials.length} trials)</h1>
${cards}
</body></html>`;

const out = path.join(runDir, "trajectory.html");
await Bun.write(out, html);
console.log(`wrote ${out}`);
