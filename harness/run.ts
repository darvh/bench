import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ARMS, ensureArmSkills, type ArmName } from "../arms/arms";

/**
 * Bench — universal docker + opencode benchmark driver.
 *
 * Every cell = one harbor job: docker image + containerized opencode +
 * official verifier. Arms differ ONLY by the installed skill + hint. Results
 * are the official task rewards; tokens/cost are provider-reported.
 *
 *   bun run harness/run.ts [--arms naive,signal] [--tasks tb21|local]
 *                          [--reps 1] [--split] [--dry-run] [--out DIR]
 */

const MODEL = "opencode-go/deepseek-v4-flash";
const VARIANT = "high";
const HERE = path.join(import.meta.dir);
const REPO = path.join(HERE, "..");
const TASKS_LOCAL = path.join(REPO, "tasks", "local");
const TB21_DATASET = "terminal-bench/terminal-bench-2-1";
const TB21_TASKS = ["crack-7z-hash", "cancel-async-tasks", "compile-compcert", "circuit-fibsqrt", "build-pmars"];
const LOCAL_TASKS = ["sql_starter", "path_starter", "ratelimit_starter"];
const CACHE = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
const JOBS = path.join(CACHE, "bench");

const args = process.argv.slice(2);
function flag(name: string, dflt: string): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? dflt;
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return dflt;
}
const arms = flag("--arms", "naive,signal").split(",") as ArmName[];
const taskScope = flag("--tasks", "tb21");
const reps = Number(flag("--reps", "2"));
const dry = args.includes("--dry-run");
const split = args.includes("--split");
const out = flag("--out", path.join(REPO, "results"));
const taskList = taskScope === "local" ? LOCAL_TASKS : TB21_TASKS;

function key(): string {
  const auth = JSON.parse(readFileSync(path.join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
  const k = auth["opencode-go"]?.key;
  if (!k) throw new Error("opencode-go key not found");
  return k;
}

async function scrubKeyInPlace(dir: string, k: string): Promise<void> {
  const stack = [dir];
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

const startedAt = new Date().toISOString();

async function gitSha(dir: string): Promise<string> {
  try {
    const p = Bun.spawn({ cmd: ["git", "-C", dir, "rev-parse", "HEAD"], stdout: "pipe", stderr: "pipe" });
    const o = await new Response(p.stdout).text();
    await p.exited;
    return o.trim();
  } catch {
    return "";
  }
}

async function jobTaskRef(jobsDir: string): Promise<string> {
  const files = await fs.readdir(jobsDir).catch(() => []);
  for (const f of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(jobsDir, f, "result.json"), "utf8"));
      const ref = d.task_id?.ref ?? d.config?.task?.ref;
      if (ref) return ref;
    } catch {}
  }
  return "";
}

const cells: { arm: ArmName; task: string; rep: number }[] = [];
for (const arm of arms) for (const task of taskList) for (let r = 1; r <= reps; r++) cells.push({ arm, task, rep: r });

if (split) {
  const { register } = await import("./monitor");
  for (const c of cells) {
    const id = `${c.arm}-${c.task}-r${c.rep}`;
    const log = path.join(JOBS, `${id}.log`);
    await fs.mkdir(path.dirname(log), { recursive: true });
    const child = Bun.spawn({
      cmd: ["bun", "run", "harness/run.ts", `--arms=${c.arm}`, `--tasks=${c.task}`, `--reps=${c.rep}`, `--out=${out}`, ...(dry ? ["--dry-run"] : [])],
      cwd: REPO,
      detached: true,
      stdout: Bun.file(log),
      stderr: Bun.file(log),
    });
    child.unref();
    await register({ id, task: c.task, arm: c.arm, pid: child.pid, outputLog: log, jobsDir: "" });
  }
  console.log(`[bench] ${cells.length} jobs launched — monitor: bun run harness/monitor.ts status`);
  process.exit(0);
}

console.log(`bench — model=${MODEL} arms=${arms.join(",")} tasks=${taskScope} reps=${reps}${dry ? " (dry-run)" : ""}`);
const k = dry ? "" : key();
const rows: Record<string, string>[] = [];

for (const c of cells) {
  const id = `${c.arm}-${c.task}-r${c.rep}`;
  const jobsDir = path.join(JOBS, id);
  const cfgPath = path.join(JOBS, `${id}.config.json`);
  const log = path.join(JOBS, `${id}.log`);
  await fs.mkdir(JOBS, { recursive: true });

  // baseline: unmodified local starter must fail its adversarial verifier
  const baseline = taskScope === "local" ? await baselineVerdict(c.task) : "n/a";
  if (dry) {
    console.log(`  ${c.arm.padEnd(12)} ${c.task.padEnd(20)} r${c.rep} baseline=${baseline} dry`);
    continue;
  }

  const arm = ARMS[c.arm];
  const skillsInfo = await ensureArmSkills(c.arm); // real host install path
  const skills = skillsInfo?.dirs;
  const cfg: Record<string, unknown> = {
    job_name: `bench-${id}`,
    jobs_dir: jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    retry: { max_retries: 0 },
    quiet: true,
    ...(taskScope === "local"
      ? { tasks: [{ path: path.join(TASKS_LOCAL, c.task) }] }
      : { datasets: [{ name: TB21_DATASET, task_names: [`terminal-bench/${c.task}`] }] }),
    agents: [
      {
        name: "opencode",
        model_name: MODEL,
        ...(skills?.length ? { skills } : {}),
        kwargs: {
          variant: VARIANT,
          opencode_config: {
            provider: { "opencode-go": { options: { baseURL: "https://opencode.ai/zen/go/v1", apiKey: k } } },
          },
        },
      },
    ],
  };
  if (arm.hint) {
    const instr = path.join(JOBS, `${id}-instruction.md`);
    await fs.writeFile(instr, arm.hint);
    (cfg as any).extra_instruction_paths = [instr];
  }
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

  const { register, heartbeat, setStatus } = await import("./monitor");
  await register({ id, task: c.task, arm: c.arm, pid: process.pid, outputLog: log, jobsDir });

  const t0 = Date.now();
  await fs.rm(jobsDir, { recursive: true, force: true });
  const p = Bun.spawn({ cmd: ["harbor", "run", "--config", cfgPath], env: { ...process.env, OPENCODE_GO_API_KEY: k }, stdout: Bun.file(log), stderr: Bun.file(log) });
  const hb = setInterval(() => heartbeat(id).catch(() => {}), 30_000);
  const code = await p.exited;
  clearInterval(hb);
  await heartbeat(id);
  const wallSec = Math.round((Date.now() - t0) / 1000);
  await scrubKeyInPlace(jobsDir, k);
  await fs.chmod(cfgPath, 0o600);
  await setStatus(id, code === 0 ? "done" : "error");

  const verdict = taskScope === "local" ? await trialVerdict(jobsDir) : await tbVerdict(jobsDir);
  const tokens = await jobTokens(jobsDir);
  const skillUsed = skills?.length ? await skillWasUsed(jobsDir, c.arm) : false;
  const taskRef = await jobTaskRef(jobsDir);
  rows.push({
    arm: c.arm, task: c.task, rep: String(c.rep), baseline, verdict, skill_used: String(skillUsed),
    tokens: String(tokens), wall: String(wallSec), task_ref: taskRef,
    started: startedAt, skill_sha: skillsInfo?.sourceSha ?? null, config: cfgPath,
  });
  console.log(`  ${c.arm.padEnd(12)} ${c.task.padEnd(20)} r${c.rep} baseline=${baseline} verdict=${verdict} skill_used=${skillUsed} ${tokens} tok ${wallSec}s`);
}

await fs.mkdir(out, { recursive: true });
const file = path.join(out, `${taskScope}.json`);
await fs.writeFile(file, JSON.stringify(rows, null, 2));
// provenance: model, arms, skill revisions, task refs, timing — everything
// needed to reproduce or audit the run.
const provenance = {
  scope: taskScope,
  model: MODEL,
  variant: VARIANT,
  arms,
  taskList,
  reps,
  startedAt,
  finishedAt: new Date().toISOString(),
  harness: `darvh/bench@${(await gitSha(path.join(REPO))).slice(0, 12)}`,
  skillSource: "github.com/darvh/signal (install.sh distribution path)",
  skillSha: rows[0]?.skill_sha ?? null,
  cells: rows.length,
  resultsFile: path.basename(file),
};
await fs.writeFile(path.join(out, `${taskScope}.provenance.json`), JSON.stringify(provenance, null, 2));
console.log(`\nresults -> ${file}`);
console.log(`provenance -> ${path.join(out, `${taskScope}.provenance.json`)}`);

async function baselineVerdict(task: string): Promise<string> {
  const d = path.join(JOBS, "baseline", task);
  await fs.mkdir(d, { recursive: true });
  await fs.cp(path.join(TASKS_LOCAL, task, "environment", "starter.py"), path.join(d, "starter.py"), { force: true });
  await fs.cp(path.join(TASKS_LOCAL, task, "tests", "verify.py"), path.join(d, "verify.py"), { force: true });
  const v = Bun.spawn({ cmd: ["python3", "verify.py"], cwd: d, stdout: "pipe", stderr: "pipe" });
  const o = await new Response(v.stdout).text();
  return /VERDICT=(\w+)/.exec(o)?.[1] ?? "error";
}

async function trialVerdict(jobsDir: string): Promise<string> {
  const files = await fs.readdir(jobsDir).catch(() => []);
  for (const f of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(jobsDir, f, "result.json"), "utf8"));
      const ev = Object.values(d.stats?.evals ?? {})[0] as any;
      const mean = ev?.metrics?.[0]?.mean;
      if (mean !== undefined) return mean === 1 ? "pass" : mean === 0 ? "fail" : String(mean);
    } catch {}
  }
  return "error";
}

async function tbVerdict(jobsDir: string): Promise<string> {
  return trialVerdict(jobsDir);
}

async function jobTokens(jobsDir: string): Promise<number> {
  let t = 0;
  const files = await fs.readdir(jobsDir).catch(() => []);
  for (const f of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(jobsDir, f, "result.json"), "utf8"));
      t += d.stats?.n_input_tokens ?? 0;
    } catch {}
  }
  return t;
}

async function skillWasUsed(jobsDir: string, arm: ArmName): Promise<boolean> {
  const files = await fs.readdir(jobsDir).catch(() => []);
  for (const f of files) {
    try {
      const text = await fs.readFile(path.join(jobsDir, f, "agent", "opencode.txt"), "utf8");
      if (text.includes(`"tool":"skill"`) && text.includes(arm)) return true;
      if (new RegExp(`"skill"[^}]*${arm.replace("+", "\\+")}`, "i").test(text)) return true;
    } catch {}
  }
  return false;
}
