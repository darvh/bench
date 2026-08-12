import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Post-pass report: merges a run's result files into the comparison the bench
 * exists for — per arm: did the skill trigger, how many tokens, did it pass.
 *
 *   bun run harness/report.ts [results/<runId>]   # default: newest run
 */

type Row = Record<string, string>;

const resultsRoot = path.join(import.meta.dir, "..", "results");
const runDir = process.argv[2] ?? path.join(resultsRoot, newestRun(resultsRoot));

function newestRun(root: string): string {
  const dirs = readdirSync(root).filter((d) => {
    try {
      return statSync(path.join(root, d)).isDirectory();
    } catch {
      return false;
    }
  });
  return dirs.sort().at(-1) ?? "";
}
import { statSync } from "node:fs";

const rows: Row[] = [];
for (const f of readdirSync(runDir)) {
  if (!f.endsWith(".json") || f.endsWith(".provenance.json")) continue;
  try {
    const r = JSON.parse(readFileSync(path.join(runDir, f), "utf8"));
    if (Array.isArray(r)) rows.push(...(r as Row[]));
  } catch {}
}

const arms = [...new Set(rows.map((r) => r.arm))];
const pad = (s: string, n: number) => s.padEnd(n);

console.log(pad("arm", 16) + pad("task", 16) + pad("verdict", 8) + pad("skill_used", 12) + pad("tokens", 10) + "wall");
for (const arm of arms) {
  for (const r of rows.filter((x) => x.arm === arm)) {
    console.log(pad(r.arm, 16) + pad(r.task, 16) + pad(r.verdict, 8) + pad(r.skill_used, 12) + pad(r.tokens, 10) + r.wall + "s");
  }
}

console.log("\nper-arm summary");
console.log(pad("arm", 16) + pad("pass", 6) + pad("fail", 6) + pad("skill%", 8) + pad("tok-med", 8) + "cells");
for (const arm of arms) {
  const cells = rows.filter((x) => x.arm === arm);
  const pass = cells.filter((r) => r.verdict === "pass").length;
  const fail = cells.filter((r) => r.verdict === "fail").length;
  const trig = cells.filter((r) => r.skill_used === "true").length;
  const toks = cells.map((r) => Number(r.tokens)).filter((n) => n > 0).sort((a, b) => a - b);
  const med = toks.length ? toks[Math.floor(toks.length / 2)] : 0;
  console.log(pad(arm, 16) + pad(String(pass), 6) + pad(String(fail), 6) + pad(String(Math.round((trig / cells.length) * 100)) + "%", 8) + pad(String(med), 8) + String(cells.length));
}
