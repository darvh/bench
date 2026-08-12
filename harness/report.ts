import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Post-pass report: turns results/<scope>.json into the comparison the bench
 * exists for — per arm: did the skill trigger, how many tokens, did it pass.
 *
 *   bun run harness/report.ts [results/local.json]
 */

type Row = Record<string, string>;

const file = process.argv[2] ?? path.join(import.meta.dir, "..", "results", "local.json");
const rows = JSON.parse(readFileSync(file, "utf8")) as Row[];

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
