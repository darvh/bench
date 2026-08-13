import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ARMS, stageSkills, armSkillNames, armSkillRefs, type ArmName } from "../arms/arms";
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
const taskDir = flag("--task-dir", ""); // local task dir (e.g. tasks/ponytail)
// tb21 task names carry a "terminal-bench/" prefix in the dataset; swe-bench
// instance ids are "swe-bench/django__django-11099".
const taskPrefix = flag("--task-prefix", datasetName.startsWith("swe-bench") ? "swe-bench/" : "terminal-bench/");
// tier from the value: "tb21" or a single known task name (split cells)
const taskScope = taskArg === "tb21" || TB21_TASKS.includes(taskArg) ? "tb21" : taskArg;
const taskList = taskArg === "tb21" ? TB21_TASKS : [taskArg];
const reps = Number(flag("--reps", "2"));
const dry = args.includes("--dry-run");
const skillsSrc = flag("--skills-src", "local"); // local (staged host install) | remote (git ref)
const agentTimeoutMult = Number(flag("--agent-timeout-mult", "1.0"));
const repFlag = flag("--rep", ""); // split children carry their rep for file naming
const agent = (flag("--agent", "pi") === "opencode" ? "opencode" : "pi") as "opencode" | "pi";
const probeSkills = args.includes("--probe-skills");
const alwaysOn = flag("--mode", "skill") === "always-on"; // mount skill content as AGENTS.md
const useRtk = args.includes("--rtk"); // pi + rtk: compress bash outputs in-container
const capOutput = args.includes("--cap-output"); // cap large tool results fed back to the model
const RTK_BIN = path.join(CACHE, "bench", "rtk", "rtk");
const RTK_PI_EXT = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode", "repos", "rtk", "hooks", "pi", "rtk.ts");
const CAP_OUTPUT_EXT = path.join(HERE, "pi-extensions", "capoutput.ts");
const agPath = flag("--ag-path", datasetName.startsWith("swe-bench") ? "/testbed/AGENTS.md" : "/app/AGENTS.md");
const stallTimeoutSec = Number(flag("--stall-timeout-sec", "0"));
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

if (alwaysOn && skillsSrc === "remote") {
  throw new Error("--mode=always-on requires --skills-src=local");
}

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
  const skillsInfo = skillsSrc === "remote" ? undefined : await stageSkills(c.arm, path.join(JOBS_RUN, "skills", id));
  const skills = skillsSrc === "remote" ? armSkillRefs(c.arm) : skillsInfo?.dirs;

  // always-on mode: mount the whole skill dir(s) into the task cwd + an
  // AGENTS.md pointer (the agent reads them every session — no opt-in tool)
  let alwaysOnCfg: NonNullable<Parameters<typeof runCell>[0]["alwaysOn"]> | undefined;
  if (alwaysOn && skills) {
    const cwd = path.dirname(agPath);
    const mounts: { source: string; target: string }[] = [];
    const refs: string[] = [];
    for (const dir of skills) {
      // stageSkills returns a root containing <skill>/SKILL.md. Mount each
      // skill at its own expected path, including combined arms.
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const nestedSkills: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (await fs.access(path.join(dir, entry.name, "SKILL.md")).then(() => true).catch(() => false)) {
          nestedSkills.push(entry.name);
        }
      }
      if (nestedSkills.length) {
        for (const name of nestedSkills) {
          mounts.push({ source: path.join(dir, name), target: path.posix.join(cwd, `.${name}`) });
          refs.push(`.${name}/SKILL.md`);
        }
      } else {
        const name = path.basename(dir);
        mounts.push({ source: dir, target: path.posix.join(cwd, `.${name}`) });
        refs.push(`.${name}/SKILL.md`);
      }
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
      ...(useRtk ? { rtk: { bin: RTK_BIN, ext: RTK_PI_EXT } } : {}),
      ...(capOutput ? { capOutput: CAP_OUTPUT_EXT } : {}),
      datasetName,
      taskPrefix,
      taskDir: taskDir || undefined,
      agentTimeoutMult,
      stallTimeoutSec,
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
    completion: res.completion, skill_used: String(res.skillUsed), tokens: String(res.tokens), cost_usd: String(res.costUsd),
    wall: String(res.wallSec), task_ref: res.taskRef, started: startedAt,
    skill_sha: res.skillSha || skillsInfo?.sourceSha || "", skill_source: res.skillSource,
  });
  console.log(`  ${c.arm.padEnd(12)} ${c.task.padEnd(20)} r${c.rep} verdict=${res.verdict} completion=${res.completion} skill_used=${res.skillUsed} ${res.tokens} tok $${res.costUsd} ${res.wallSec}s`);
}

await fs.mkdir(outRun, { recursive: true });
// single-arm invocations (split children) write per-arm files so parallel
// cells never clobber each other's results; rep comes from --rep (the child
// runs --reps=1, so cells[0].rep is always 1)
const rep = repFlag || String(cells[0]?.rep ?? 1);
const file = arms.length === 1
  ? path.join(outRun, `${taskScope}-${arms[0]}-r${rep}.json`)
  : path.join(outRun, `${taskScope}.json`);
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
