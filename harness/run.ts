import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ARMS, stageSkills, armSkillNames, armSkillRefs, armSkillContent, type ArmName } from "../arms/arms";
import { runCell, MODEL, VARIANT, PRICE_INPUT_MISS_PER_1M, PRICE_INPUT_HIT_PER_1M, PRICE_OUTPUT_PER_1M, type CellResult } from "./cell";

/**
 * Bench — universal docker + opencode benchmark driver.
 *
 * Every cell = one harbor job: docker image + containerized opencode +
 * official verifier. Arms differ ONLY by the installed skill. Results are
 * the official task rewards; tokens/cost are provider-reported.
 *
 *   bun run harness/run.ts [--arms naive,signal] [--tasks tb21|<task>]
 *                          [--reps 1] [--split] [--dry-run] [--out DIR]
 *                          [--skills-src local|remote]
 */

const HERE = path.join(import.meta.dir);
const REPO = path.join(HERE, "..");
const TB21_DATASET = "terminal-bench/terminal-bench-2-1";
const TB21_TASKS = ["crack-7z-hash", "cancel-async-tasks", "compile-compcert", "circuit-fibsqrt", "build-pmars"];
const CACHE = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
const JOBS = path.join(CACHE, "bench");
const ARCHIVE = process.env.BENCH_ARCHIVE ?? path.join(REPO, "..", "bench-archive");

const args = process.argv.slice(2);
function flag(name: string, dflt: string): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? dflt;
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return dflt;
}
const arms = flag("--arms", "naive,signal").split(",") as ArmName[];
const taskArg = flag("--tasks", "tb21");
const datasetName = flag("--dataset", TB21_DATASET);
// tb21 task names carry a "terminal-bench/" prefix in the dataset; swe-bench
// instance ids are "swe-bench/django__django-11099".
const taskPrefix = flag("--task-prefix", datasetName.startsWith("swe-bench") ? "swe-bench/" : "terminal-bench/");
// tier from the value: "tb21" or a single known task name (split cells)
const taskScope = taskArg === "tb21" || TB21_TASKS.includes(taskArg) ? "tb21" : taskArg;
const taskList = taskArg === "tb21" ? TB21_TASKS : [taskArg];
const reps = Number(flag("--reps", "2"));
const dry = args.includes("--dry-run");
const split = args.includes("--split");
const skillsSrc = flag("--skills-src", "local"); // local (staged host install) | remote (git ref)
const agentTimeoutMult = Number(flag("--agent-timeout-mult", "1.0"));
const agent = (flag("--agent", "pi") === "opencode" ? "opencode" : "pi") as "opencode" | "pi";
const probeSkills = args.includes("--probe-skills");
const alwaysOn = flag("--mode", "skill") === "always-on"; // mount skill content as AGENTS.md
const agPath = flag("--ag-path", datasetName.startsWith("swe-bench") ? "/testbed/AGENTS.md" : "/app/AGENTS.md");
const out = flag("--out", path.join(REPO, "results"));
// every invocation gets its own folder under jobs + results — nothing overwrites
const runId = flag("--run-id", new Date().toISOString().replace(/[:.]/g, "-"));
const JOBS_RUN = path.join(JOBS, runId);
const outRun = path.join(out, runId);

function key(): string {
  const auth = JSON.parse(readFileSync(path.join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
  const k = auth["opencode-go"]?.key;
  if (!k) throw new Error("opencode-go key not found in auth.json");
  return k;
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

const cells: { arm: ArmName; task: string; rep: number }[] = [];
for (const arm of arms) for (const task of taskList) for (let r = 1; r <= reps; r++) cells.push({ arm, task, rep: r });

if (split) {
  const { register } = await import("./monitor");
  for (const c of cells) {
    const id = `${c.arm}-${c.task}-r${c.rep}`;
    const log = path.join(JOBS_RUN, `${id}.log`);
    await fs.mkdir(path.dirname(log), { recursive: true });
    const child = Bun.spawn({
      cmd: ["bun", "run", "harness/run.ts", `--arms=${c.arm}`, `--tasks=${c.task}`, `--reps=${c.rep}`, `--out=${out}`, `--run-id=${runId}`, `--dataset=${datasetName}`, `--task-prefix=${taskPrefix}`, `--agent-timeout-mult=${agentTimeoutMult}`, `--skills-src=${skillsSrc}`, `--agent=${agent}`, ...(alwaysOn ? [`--mode=always-on`, `--ag-path=${agPath}`] : []), ...(probeSkills ? ["--probe-skills"] : []), ...(dry ? ["--dry-run"] : [])],
      cwd: REPO,
      detached: true,
      stdout: Bun.file(log),
      stderr: Bun.file(log),
    });
    child.unref();
    await register({ id, runId, task: c.task, arm: c.arm, pid: child.pid, outputLog: log, jobsDir: path.join(JOBS_RUN, id) });
  }
  console.log(`[bench] ${cells.length} jobs launched (run ${runId}) — monitor: bun run harness/monitor.ts status`);
  process.exit(0);
}

console.log(`bench — model=${MODEL} variant=${VARIANT} run=${runId} arms=${arms.join(",")} tasks=${taskScope} reps=${reps}${dry ? " (dry-run)" : ""}`);
const k = dry ? "" : key();
const rows: Record<string, string>[] = [];
const { register, heartbeat, setStatus, loadState, isAlive } = await import("./monitor");

for (const c of cells) {
  const id = `${c.arm}-${c.task}-r${c.rep}`;
  const jobsDir = path.join(JOBS_RUN, id);
  const log = path.join(JOBS_RUN, `${id}.log`);
  await fs.mkdir(JOBS_RUN, { recursive: true });

  // never clobber a live run sharing this id (would corrupt its jobs dir);
  // in split mode the parent pre-registers this very process — exclude self
  const live = (await loadState()).find((r) => r.id === id && r.status === "running" && r.pid !== process.pid && isAlive(r));
  if (live) {
    console.log(`  ${id} — already running (pid ${live.pid}), skipping`);
    continue;
  }

  if (dry) {
    console.log(`  ${c.arm.padEnd(12)} ${c.task.padEnd(20)} r${c.rep} dry`);
    continue;
  }

  const arm = ARMS[c.arm];
  // skills source: staged host install (default) or remote git ref (harbor
  // resolves org/name or tree URL, sparse-checkout into cache)
  const skillsInfo = skillsSrc === "remote" ? undefined : await stageSkills(c.arm, path.join(JOBS, "skills"));
  const skills = skillsSrc === "remote" ? armSkillRefs(c.arm) : skillsInfo?.dirs;

  // always-on mode: mount the whole skill dir(s) into the task cwd + an
  // AGENTS.md pointer (the agent reads them every session — no opt-in tool)
  let alwaysOnCfg: NonNullable<Parameters<typeof runCell>[0]["alwaysOn"]> | undefined;
  if (alwaysOn && skills) {
    const cwd = path.dirname(agPath);
    const mounts: { source: string; target: string }[] = [];
    const refs: string[] = [];
    for (const dir of skills) {
      const name = path.basename(dir);
      const target = path.posix.join(cwd, `.${name}`);
      mounts.push({ source: dir, target });
      refs.push(`.${name}/SKILL.md`);
    }
    const agFile = path.join(JOBS_RUN, `${id}.AGENTS.md`);
    await fs.writeFile(
      agFile,
      `Follow the guidance in ${refs.join(" and ")} (including their fragments/ directories) for this task.\n`,
    );
    alwaysOnCfg = { mounts, agHostFile: agFile, agTarget: agPath };
  }

  await register({ id, runId, task: c.task, arm: c.arm, pid: process.pid, outputLog: log, jobsDir });
  const hb = setInterval(() => heartbeat(id).catch(() => {}), 30_000);
  let res: CellResult;
  try {
    res = await runCell({
      id,
      runId,
      arm: c.arm,
      task: c.task,
      agent,
      jobsDir,
      log,
      apiKey: k,
      hint: arm.hint,
      skills: alwaysOnCfg ? undefined : skills,
      skillNames: armSkillNames(c.arm),
      probeSkills,
      alwaysOn: alwaysOnCfg,
      datasetName,
      taskPrefix,
      agentTimeoutMult,
      archiveRoot: ARCHIVE,
      repoSessionsDir: path.join(outRun, "sessions"),
    });
  } finally {
    clearInterval(hb);
    await heartbeat(id);
  }
  await setStatus(id, res.ok ? "done" : "error");

  rows.push({
    arm: c.arm, task: c.task, rep: String(c.rep), verdict: res.verdict,
    skill_used: String(res.skillUsed), tokens: String(res.tokens), cost_usd: String(res.costUsd),
    wall: String(res.wallSec), task_ref: res.taskRef, started: startedAt,
    skill_sha: res.skillSha || skillsInfo?.sourceSha || "", skill_source: res.skillSource,
  });
  console.log(`  ${c.arm.padEnd(12)} ${c.task.padEnd(20)} r${c.rep} verdict=${res.verdict} skill_used=${res.skillUsed} ${res.tokens} tok $${res.costUsd} ${res.wallSec}s`);
}

await fs.mkdir(outRun, { recursive: true });
// single-arm invocations (split children) write per-arm files so parallel
// cells never clobber each other's results
const file = path.join(outRun, arms.length === 1 ? `${taskScope}-${arms[0]}.json` : `${taskScope}.json`);
await fs.writeFile(file, JSON.stringify(rows, null, 2));
// provenance: model, arms, skill revisions, task refs, timing — everything
// needed to reproduce or audit the run.
const provenance = {
  runId,
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
  skillSha: rows[0]?.skill_sha ?? "",
  pricePer1M: { input_miss: PRICE_INPUT_MISS_PER_1M, input_hit: PRICE_INPUT_HIT_PER_1M, output: PRICE_OUTPUT_PER_1M },
  cells: rows.length,
  resultsFile: path.basename(file),
};
await fs.writeFile(path.join(outRun, `${path.basename(file, ".json")}.provenance.json`), JSON.stringify(provenance, null, 2));
console.log(`\nresults -> ${file}`);
console.log(`provenance -> ${path.join(outRun, `${path.basename(file, ".json")}.provenance.json`)}`);
console.log(`view -> bun run harness/view.ts ${runId}   (native harbor viewer on the jobs dir)`);
