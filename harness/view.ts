import path from "node:path";
import { homedir } from "node:os";

/**
 * Open the native harbor viewer for a run's jobs dir.
 *
 *   bun run harness/view.ts [runId]      # default: newest run
 */

const CACHE = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
const JOBS = path.join(CACHE, "bench");

const readdirSafe = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
import { readdirSync } from "node:fs";

const runId = process.argv[2] ?? readdirSafe(JOBS).filter((d) => !d.endsWith(".log") && !d.includes(".")).sort().at(-1) ?? "";
if (!runId) {
  console.error("no runs under " + JOBS);
  process.exit(1);
}
const jobsDir = path.join(JOBS, runId);
console.log(`harbor view ${jobsDir}`);
const p = Bun.spawn({ cmd: ["harbor", "view", jobsDir], stdout: "inherit", stderr: "inherit" });
await p.exited;
