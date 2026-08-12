import { promises as fs } from "node:fs";
import path from "node:path";
import type { ArmName } from "../arms/arms";

/**
 * Per-cell runner: one harbor job = docker image + fresh opencode +
 * official verifier. Arms differ ONLY by the installed skill + hint.
 *
 * Key hygiene: the apiKey lives in memory only; it is written (0600) into the
 * config file inside jobsDir and scrubbed from jobsDir + the log after the
 * run. Nothing else ever sees it.
 */

export const MODEL = "opencode-go/deepseek-v4-flash";
export const VARIANT = "high";
export const GO_BASE_URL = "https://opencode.ai/zen/go/v1";

// DeepSeek V4 Flash pricing (per 1M tokens): cache-miss input, cache-hit, output.
export const PRICE_INPUT_MISS_PER_1M = 0.14;
export const PRICE_INPUT_HIT_PER_1M = 0.0028;
export const PRICE_OUTPUT_PER_1M = 0.28;

export interface CellResult {
  ok: boolean;
  verdict: string;
  tokens: number;
  costUsd: number;
  skillUsed: boolean;
  taskRef: string;
  wallSec: number;
}

export interface CellOpts {
  id: string;
  runId: string;
  arm: ArmName;
  task: string;
  jobsDir: string;
  log: string;
  apiKey: string;
  hint?: string;
  skills?: string[];
  skillNames?: string[]; // which skill names the arm expects to be loaded
  datasetName: string;
  taskPrefix: string; // e.g. "terminal-bench/" or "swe-bench/" for instance ids
  agentTimeoutMult: number; // multiplier on the task's agent timeout
  archiveRoot: string; // transcripts land in <archiveRoot>/transcripts/<runId>/<id>/<trial>/
  repoSessionsDir: string; // repo copy: <results>/<runId>/sessions/<id>/<trial>/
}

export async function runCell(o: CellOpts): Promise<CellResult> {
  await fs.rm(o.jobsDir, { recursive: true, force: true });
  await fs.rm(o.log, { force: true });
  await fs.mkdir(o.jobsDir, { recursive: true });

  if (o.hint) {
    const instr = path.join(o.jobsDir, "instruction.md");
    await writePrivate(instr, o.hint);
  }

  const cfg: Record<string, unknown> = {
    job_name: `bench-${o.id}`,
    jobs_dir: o.jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    retry: { max_retries: 0 },
    quiet: true,
    agent_timeout_multiplier: o.agentTimeoutMult,
    datasets: [{ name: o.datasetName, task_names: o.taskPrefix ? [`${o.taskPrefix}${o.task}`] : [o.task] }],
    agents: [
      {
        name: "opencode",
        model_name: MODEL,
        ...(o.skills?.length ? { skills: o.skills } : {}),
        kwargs: {
          variant: VARIANT,
          opencode_config: {
            provider: {
              "opencode-go": { options: { baseURL: GO_BASE_URL, apiKey: o.apiKey } },
            },
          },
        },
      },
    ],
  };
  const cfgPath = path.join(o.jobsDir, "config.json");
  await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));

  if (o.hint) {
    const instr = path.join(o.jobsDir, "instruction.md");
    await writePrivate(instr, o.hint);
    cfg.extra_instruction_paths = [instr];
    await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));
  }

  const t0 = Date.now();
  const p = Bun.spawn({
    cmd: ["harbor", "run", "--config", cfgPath],
    stdout: Bun.file(o.log),
    stderr: Bun.file(o.log),
  });
  const code = await p.exited;
  const wallSec = Math.round((Date.now() - t0) / 1000);

  // key hygiene: scrub jobsDir (incl. config.json) + the harbor log
  await scrubKeyInPlace(o.jobsDir, o.apiKey);
  await scrubKeyInPlace(o.log, o.apiKey);

  await archiveTranscripts(o.jobsDir, path.join(o.archiveRoot, "transcripts", o.runId), o.id, true);
  await archiveTranscripts(o.jobsDir, o.repoSessionsDir, o.id, false);

  const verdict = await trialVerdict(o.jobsDir);
  const tokens = await jobTokens(o.jobsDir);
  const costUsd = await jobCostUsd(o.jobsDir);
  const skillUsed = o.skillNames?.length ? await skillWasUsed(o.jobsDir, o.skillNames) : false;
  const taskRef = await jobTaskRef(o.jobsDir);
  return { ok: code === 0, verdict, tokens, costUsd, skillUsed, taskRef, wallSec };
}

// ---- result.json discovery ----
// Harbor writes the aggregated stats (evals, tokens) to the JOB-level
// result.json (jobs_dir/<job_name>/result.json) and per-trial records
// (agent_result, transcripts) to jobs_dir/<job_name>/<trial>/.

// The job-level record: the first result.json carrying stats.evals. Returns
// its path, or null.
async function jobResultPath(jobsDir: string): Promise<string | null> {
  const candidates: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      candidates.push(p);
      await walk(p, depth + 1);
    }
  };
  await walk(jobsDir, 0);
  for (const p of candidates) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(p, "result.json"), "utf8"));
      if (d.stats?.evals) return path.join(p, "result.json");
    } catch {}
  }
  return null;
}

async function jobResult(jobsDir: string): Promise<Record<string, any> | null> {
  const p = await jobResultPath(jobsDir);
  if (!p) return null;
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// Trial dirs: result.json with an agent/ subdir (transcripts live there).
async function trialDirs(jobsDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      const hasResult = await fs.access(path.join(p, "result.json")).then(() => true).catch(() => false);
      if (hasResult && (await fs.access(path.join(p, "agent")).then(() => true).catch(() => false))) found.push(p);
      else await walk(p, depth + 1);
    }
  };
  await walk(jobsDir, 0);
  return found;
}

async function trialVerdict(jobsDir: string): Promise<string> {
  const d = await jobResult(jobsDir);
  if (!d) return "error";
  const ev = Object.values(d.stats.evals)[0] as any;
  const mean = ev?.metrics?.[0]?.mean;
  if (mean !== undefined) return mean === 1 ? "pass" : mean === 0 ? "fail" : String(mean);
  return "error";
}

async function jobTokens(jobsDir: string): Promise<number> {
  const d = await jobResult(jobsDir);
  return d?.stats?.n_input_tokens ?? 0;
}

// Cost at the DeepSeek V4 Flash schedule: cache-miss writes at the full input
// rate, cache hits at 98% off, output flat.
async function jobCostUsd(jobsDir: string): Promise<number> {
  const d = await jobResult(jobsDir);
  if (!d?.stats) return 0;
  const s = d.stats;
  const miss = (s.n_input_tokens ?? 0) - (s.n_cache_tokens ?? 0);
  const hit = s.n_cache_tokens ?? 0;
  const out = s.n_output_tokens ?? 0;
  const usd = (miss * PRICE_INPUT_MISS_PER_1M + hit * PRICE_INPUT_HIT_PER_1M + out * PRICE_OUTPUT_PER_1M) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

async function jobTaskRef(jobsDir: string): Promise<string> {
  const d = await jobResult(jobsDir);
  const ref = d?.task_id?.ref ?? d?.config?.task?.ref;
  return ref ?? "";
}

// Preserve each trial's session transcript + verdict in the archive (outside
// the repo — transcripts are large and not for git). The jobs dir may be
// cleaned later; this is the durable copy.
//
// result.json = the JOB-level record (stats.evals = the verdict, tokens —
// the same values the result rows are built from); trial.json = the per-trial
// record (agent_result, exception_info); trajectory.json + opencode.txt =
// the session.
async function archiveTranscripts(jobsDir: string, archive: string, id: string, withTranscript: boolean): Promise<void> {
  const jobResult = await jobResultPath(jobsDir);
  for (const dir of await trialDirs(jobsDir)) {
    const trialName = path.basename(dir);
    const src = path.join(dir, "agent", "opencode.txt");
    if (!(await fs.access(src).then(() => true).catch(() => false))) continue;
    const dest = path.join(archive, id, trialName);
    await fs.mkdir(dest, { recursive: true });
    if (withTranscript) await fs.copyFile(src, path.join(dest, "opencode.txt"));
    if (jobResult) await fs.copyFile(jobResult, path.join(dest, "result.json"));
    await fs.copyFile(path.join(dir, "result.json"), path.join(dest, "trial.json")).catch(() => {});
    await fs.copyFile(path.join(dir, "agent", "trajectory.json"), path.join(dest, "trajectory.json")).catch(() => {});
  }
}

async function skillWasUsed(jobsDir: string, names: string[]): Promise<boolean> {
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const text = await fs.readFile(path.join(dir, "agent", "opencode.txt"), "utf8");
      for (const name of names) {
        if (text.includes(`"tool":"skill"`) && text.includes(name)) return true;
        if (new RegExp(`"skill"[^}]*${name.replace("+", "\\+")}`, "i").test(text)) return true;
      }
    } catch {}
  }
  return false;
}

// ---- key hygiene helpers ----

// Write with 0600 so the key never sits in a world-readable file.
async function writePrivate(file: string, data: string): Promise<void> {
  const fh = await fs.open(file, "w", 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

// Replace every occurrence of k in a file or a whole directory tree.
async function scrubKeyInPlace(target: string, k: string): Promise<void> {
  const st = await fs.stat(target).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    const t = await fs.readFile(target, "utf8").catch(() => "");
    if (t.includes(k)) await fs.writeFile(target, t.split(k).join("REDACTED"));
    return;
  }
  const stack = [target];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          const t = await fs.readFile(p, "utf8");
          if (t.includes(k)) await fs.writeFile(p, t.split(k).join("REDACTED"));
        } catch {}
      }
    }
  }
}
