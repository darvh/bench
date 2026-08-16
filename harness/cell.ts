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
  completion: "normal" | "terminated" | "timeout" | "error";
  tokens: number;
  costUsd: number;
  skillUsed: boolean; // any skill read
  skillUsage: Record<string, boolean>; // per-skill: { signal: true, ponytail: false }
  taskRef: string;
  wallSec: number;
  skillSha: string; // harbor-recorded provenance: git commit sha or content digest
  skillSource: string;
  stalled: boolean; // watchdog killed the agent — retry, don't score
  attempts: number; // attempts consumed incl. retries (1 = clean)
  discardedCostUsd: number; // tokens/cost burned by stalled/immediate-failed attempts that were discarded
  exceptionType: string; // trial exception_type when completion != normal
}

export interface CellOpts {
  id: string;
  runId: string;
  arm: ArmName;
  task: string;
  agent: "opencode" | "pi";
  jobsDir: string;
  log: string;
  apiKey: string;
  hint?: string;
  skills?: string[];
  skillNames?: string[]; // which skill names the arm expects to be loaded
  probeSkills?: boolean; // append "report the skills you see" to the instruction
  alwaysOn?: {
    mounts: { source: string; target: string }[]; // skill dir + AGENTS.md into the task cwd
    agHostFile: string; // generated AGENTS.md (host path, mounted read-only)
    agTarget: string;
  };
  rtk?: { bin: string; ext: string }; // pi + rtk: compress bash outputs
  capOutput?: string; // pi extension that caps large tool results (host path)
  datasetName: string;
  taskPrefix: string; // e.g. "terminal-bench/" or "swe-bench/" for instance ids
  taskDir?: string; // local task dir (tasks/ponytail/...) — uses tasks:[{path}] instead of datasets
  agentTimeoutMult: number; // multiplier on the task's agent timeout
  stallTimeoutSec: number; // optional transcript watchdog; 0 disables it
  archiveRoot: string; // transcripts land in <archiveRoot>/transcripts/<runId>/<id>/<trial>/
  repoSessionsDir: string; // repo copy: <results>/<runId>/sessions/<id>/<trial>/
}

function transcriptName(agent: "opencode" | "pi"): string {
  return agent === "pi" ? "pi.txt" : "opencode.txt";
}
function buildAgent(o: CellOpts): Record<string, unknown> {
  if (o.agent === "pi") {
    return {
      name: "pi",
      model_name: "opencode-go/deepseek-v4-flash",
      ...(o.skills?.length ? { skills: o.skills } : {}),
      env: { OPENCODE_API_KEY: o.apiKey },
      kwargs: { thinking: "high" },
    };
  }
  return {
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
  };
}

export async function runCell(o: CellOpts): Promise<CellResult> {
  // retry fresh when: the watchdog killed a stall, or the cell failed before
  // doing real work (setup/config error) — only a non-stalled, worked attempt
  // counts as final.
  const maxAttempts = 3;
  let last: CellResult | null = null;
  let discardedCostUsd = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await runAttempt(o);
    last = res;
    const immediate = !res.ok && res.tokens === 0 && res.wallSec < 180;
    if (!res.stalled && !immediate) return { ...res, attempts: attempt, discardedCostUsd };
    // this attempt is being discarded (stall kill or immediate failure): its
    // tokens/cost never contributed to a scored result — preserve them so the
    // report can show the true cost incl. retries.
    discardedCostUsd += res.costUsd;
    console.log(`[cell] ${o.task} (${o.id}): ${res.stalled ? "stalled" : "immediate failure"} attempt ${attempt}/${maxAttempts} — retrying`);
  }
  return { ...last!, ok: false, verdict: "error", tokens: 0, costUsd: 0, attempts: maxAttempts, discardedCostUsd };
}

async function runAttempt(o: CellOpts): Promise<CellResult> {
  stallFlag.delete(o.jobsDir); // reset per attempt
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
    ...(o.rtk || o.capOutput
      ? {
          environment: {
            mounts: [
              ...(o.alwaysOn?.mounts ?? []).map((m) => ({ type: "bind", source: m.source, target: m.target, read_only: true })),
              ...(o.alwaysOn ? [{ type: "bind", source: o.alwaysOn.agHostFile, target: o.alwaysOn.agTarget, read_only: true }] : []),
              ...(o.rtk ? [{ type: "bind", source: o.rtk.bin, target: "/usr/local/bin/rtk", read_only: true }] : []),
              ...(o.rtk ? [{ type: "bind", source: o.rtk.ext, target: "/root/.pi/agent/extensions/rtk.ts", read_only: true }] : []),
              ...(o.capOutput ? [{ type: "bind", source: o.capOutput, target: "/root/.pi/agent/extensions/capoutput.ts", read_only: true }] : []),
            ],
          },
        }
      : o.alwaysOn
        ? {
            environment: {
              mounts: [
                ...o.alwaysOn.mounts.map((m) => ({ type: "bind", source: m.source, target: m.target, read_only: true })),
                { type: "bind", source: o.alwaysOn.agHostFile, target: o.alwaysOn.agTarget, read_only: true },
              ],
            },
          }
        : {}),
    ...(o.taskDir
      ? { tasks: [{ path: path.join(o.taskDir, o.task) }] }
      : { datasets: [{ name: o.datasetName, task_names: o.taskPrefix ? [`${o.taskPrefix}${o.task}`] : [o.task] }] }),
    agents: [buildAgent(o)],
  };
  const cfgPath = path.join(o.jobsDir, "config.json");
  await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));

  if (o.hint) {
    const instr = path.join(o.jobsDir, "instruction.md");
    await writePrivate(instr, o.hint);
    cfg.extra_instruction_paths = [instr];
    await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));
  }

  if (o.probeSkills) {
    const probe = path.join(o.jobsDir, "probe-skills.md");
    await writePrivate(probe, "Once, at the start: report the names of the skills available to you as tools. If none are available, reply NONE.");
    cfg.extra_instruction_paths = [...(cfg.extra_instruction_paths as string[] ?? []), probe];
    await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));
  }

  // hard stop directive: prevents the agent from starting follow-up turns after
  // the task is done (which is when pi/opencode hang on the gateway)
  {
    const stop = path.join(o.jobsDir, "bench-stop.md");
    await writePrivate(stop, "When the task is complete, STOP immediately. Do not continue working, do not ask follow-up questions, do not start another turn.");
    cfg.extra_instruction_paths = [...(cfg.extra_instruction_paths as string[] ?? []), stop];
    await writePrivate(cfgPath, JSON.stringify(cfg, null, 2));
  }

  const t0 = Date.now();
  const p = Bun.spawn({
    cmd: ["harbor", "run", "--config", cfgPath],
    stdout: Bun.file(o.log),
    stderr: Bun.file(o.log),
    // pi reads the go key via OPENCODE_API_KEY env; opencode gets it via config
    env: o.agent === "pi" ? { ...process.env, OPENCODE_API_KEY: o.apiKey } : { ...process.env },
  });
  // opencode occasionally hangs after finishing its turn (events stop, process
  // never exits) — the cell would otherwise burn the full agent timeout.
  // Watch the latest transcript: if it freezes for STALL_MS, kill the opencode
  // process inside the container so harbor's pipeline ends and the verifier runs.
  const STALL_MS = 300_000;
  const poll = o.stallTimeoutSec > 0
    ? setInterval(() => stallWatch(o.jobsDir, o.task, transcriptName(o.agent), o.agent, o.stallTimeoutSec * 1000).catch(() => {}), 20_000)
    : undefined;
  // live-stream: harbor keeps the agent transcript inside the container until
  // the trial ends — poll docker cp into results/<runId>/live/<id>/ so every
  // command is visible from the repo in real time.
  const liveDir = path.join(o.repoSessionsDir, "..", "live", o.id);
  const stream = setInterval(() => streamLive(o.task, liveDir, transcriptName(o.agent), o.jobsDir).catch(() => {}), 10_000);
  const code = await p.exited;
  if (poll) clearInterval(poll);
  clearInterval(stream);
  const wallSec = Math.round((Date.now() - t0) / 1000);

  // A stall AFTER the agent signalled completion (agent_settled / final stop)
  // is the known CLI exit hang — the fix is done, so score it rather than retry.
  const stalled = (stallFlag.get(o.jobsDir) ?? false) && !(await agentCompleted(o.jobsDir, o.agent));

  // key hygiene: scrub jobsDir (incl. config.json) + the harbor log
  await scrubKeyInPlace(o.jobsDir, o.apiKey);
  await scrubKeyInPlace(o.log, o.apiKey);

  await archiveTranscripts(o.jobsDir, path.join(o.archiveRoot, "transcripts", o.runId), o.id, true, transcriptName(o.agent));
  await archiveTranscripts(o.jobsDir, o.repoSessionsDir, o.id, false, transcriptName(o.agent));

  const verdict = await trialVerdict(o.jobsDir);
  const completion = await trialCompletion(o.jobsDir, code);
  const tokens = await jobTokens(o.jobsDir);
  const costUsd = await jobCostUsd(o.jobsDir);
  const skillUsage = o.skillNames?.length
    ? await skillWasUsedPerSkill(o.jobsDir, o.skillNames, transcriptName(o.agent))
    : {};
  const skillUsed = Object.values(skillUsage).some(Boolean);
  const taskRef = await jobTaskRef(o.jobsDir);
  const prov = await skillProvenance(o.jobsDir);
  const exceptionType = await trialExceptionType(o.jobsDir);
  return { ok: code === 0, verdict, completion, tokens, costUsd, skillUsed, skillUsage, taskRef, wallSec, skillSha: prov.sha, skillSource: prov.source, stalled, attempts: 1, discardedCostUsd: 0, exceptionType };
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

async function trialCompletion(jobsDir: string, processCode: number): Promise<CellResult["completion"]> {
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8"));
      const e = d.exception_info;
      if (!e) return processCode === 0 ? "normal" : "error";
      const text = `${e.exception_type ?? ""} ${e.exception_message ?? ""}`.toLowerCase();
      if (text.includes("timeout") || text.includes("timed out")) return "timeout";
      if (text.includes("exit 143") || text.includes("terminated") || text.includes("signal")) return "terminated";
      return "error";
    } catch {}
  }
  return processCode === 0 ? "normal" : "error";
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
  const miss = Math.max(0, (s.n_input_tokens ?? 0) - (s.n_cache_tokens ?? 0));
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

// Skill provenance recorded by harbor in the trial lock.json: git_commit_id
// for git skills, content digest for local dirs.
async function skillProvenance(jobsDir: string): Promise<{ sha: string; source: string }> {
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const lock = JSON.parse(await fs.readFile(path.join(dir, "lock.json"), "utf8"));
      const skills: { name: string; source?: string; digest?: string; git_commit_id?: string; git_url?: string }[] =
        lock.skills ?? [];
      const sha = skills.map((s) => s.git_commit_id ?? s.digest ?? "").filter(Boolean).join(",");
      const source = skills.map((s) => s.git_url ?? s.source ?? s.name ?? "").filter(Boolean).join(",");
      if (sha) return { sha, source };
    } catch {}
  }
  return { sha: "", source: "" };
}

// Preserve each trial's session transcript + verdict in the archive (outside
// the repo — transcripts are large and not for git). The jobs dir may be
// cleaned later; this is the durable copy.
//
// result.json = the JOB-level record (stats.evals = the verdict, tokens —
// the same values the result rows are built from); trial.json = the per-trial
// record (agent_result, exception_info); trajectory.json + opencode.txt =
// the session.
async function archiveTranscripts(jobsDir: string, archive: string, id: string, withTranscript: boolean, transcriptFile = "opencode.txt"): Promise<void> {
  const jobResult = await jobResultPath(jobsDir);
  for (const dir of await trialDirs(jobsDir)) {
    const trialName = path.basename(dir);
    const src = path.join(dir, "agent", transcriptFile);
    if (!(await fs.access(src).then(() => true).catch(() => false))) continue;
    const dest = path.join(archive, id, trialName);
    await fs.mkdir(dest, { recursive: true });
    if (withTranscript) await fs.copyFile(src, path.join(dest, transcriptFile));
    if (jobResult) await fs.copyFile(jobResult, path.join(dest, "result.json"));
    await fs.copyFile(path.join(dir, "result.json"), path.join(dest, "trial.json")).catch(() => {});
    await fs.copyFile(path.join(dir, "agent", "trajectory.json"), path.join(dest, "trajectory.json")).catch(() => {});
  }
}

// Per-skill usage: which named skills the transcript shows the agent actually
// loaded (read the SKILL.md). Returns { signal: true, ponytail: false, ... }.
// The combined arm is only marked "both used" when BOTH flags are true.
async function skillWasUsedPerSkill(jobsDir: string, names: string[], transcriptFile: string): Promise<Record<string, boolean>> {
  const usage: Record<string, boolean> = {};
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const text = await fs.readFile(path.join(dir, "agent", transcriptFile), "utf8");
      for (const name of names) {
        if (usage[name]) continue; // already proven used for this skill
        if (text.includes(`"tool":"skill"`) && text.includes(name)) { usage[name] = true; continue; }
        if (new RegExp(`"skill"[^}]*${name.replace("+", "\\+")}`, "i").test(text)) { usage[name] = true; continue; }
        if (new RegExp(`\\.${name}[/\\][^"\\n]*SKILL\\.md`, "i").test(text)) { usage[name] = true; continue; }
        // native pi skill dir: ~/.agents/skills/<name>/SKILL.md
        if (new RegExp(`agents/skills/${name}[/\\][^"\\n]*SKILL\\.md`, "i").test(text)) { usage[name] = true; continue; }
      }
    } catch {}
  }
  return usage;
}

async function trialExceptionType(jobsDir: string): Promise<string> {
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8"));
      return d.exception_info?.exception_type ?? "";
    } catch {}
  }
  return "";
}

// Did the agent signal completion (final answer) before any stall? pi emits
// agent_settled; opencode emits a step_finish with reason "stop".
async function agentCompleted(jobsDir: string, agent: "opencode" | "pi"): Promise<boolean> {
  const transcriptFile = transcriptName(agent);
  for (const dir of await trialDirs(jobsDir)) {
    try {
      const text = await fs.readFile(path.join(dir, "agent", transcriptFile), "utf8");
      if (agent === "pi") return text.includes('"type":"agent_settled"');
      return /"reason":"stop"/.test(text);
    } catch {}
  }
  return false;
}

// ---- live stream ----

// Find this cell's trial container. Multiple concurrent cells can share a
// task slug, so match the container by the cell's trial hash (the dir name
// `<task>__<hash>` under jobsDir), not the slug.
async function findContainer(task: string, jobsDir: string): Promise<string | null> {
  const trialHash = await trialHashOf(jobsDir, task);
  const names = await Bun.$`docker ps --format {{.Names}}`.text().catch(() => "");
  const list = names.split("\n").filter(Boolean);
  if (trialHash) {
    // container hashes are lowercased by docker — compare case-insensitively
    const hit = list.find((n) => n.toLowerCase().includes(trialHash.toLowerCase()));
    if (hit) return hit;
  }
  // Never fall back to slug-matching: parallel cells on the same task slug all
  // match, so `find` returns an arbitrary container — a misattribution bug in
  // the live stream. Without the trial hash, do not stream rather than stream
  // the wrong cell's transcript.
  return null;
}

// Find `<task>__<hash>` dir under jobsDir; return the hash.
async function trialHashOf(jobsDir: string, task: string): Promise<string | null> {
  const slug = task.split("/").pop()!;
  const walk = async (d: string, depth: number): Promise<string | null> => {
    if (depth > 3) return null;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name.startsWith(`${slug}__`)) {
        const hash = e.name.slice(slug.length + 2);
        if (hash) return hash;
      }
      const deeper = await walk(p, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(jobsDir, 0);
}

// Copy the live agent transcript out of the container into the repo.
async function streamLive(task: string, liveDir: string, transcriptFile: string, jobsDir: string): Promise<void> {
  const c = await findContainer(task, jobsDir);
  if (!c) return;
  await fs.mkdir(liveDir, { recursive: true });
  await Bun.$`docker cp ${c}:/logs/agent/${transcriptFile} ${liveDir}/${transcriptFile}`.quiet().catch(() => {});
}

// ---- stall watchdog ----

// State kept per cell: last seen transcript size and when it froze.
const stallState = new Map<string, { size: number; frozenAt: number }>();
// Set when the watchdog kills the agent this attempt (triggers a retry).
const stallFlag = new Map<string, boolean>();

// Find the newest opencode.txt under jobsDir (recursive), its (size, mtime).
async function transcriptStats(jobsDir: string, transcriptFile: string): Promise<{ size: number; mtime: number } | null> {
  const found: { path: string; mtime: number }[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name === transcriptFile) {
        const st = await fs.stat(p).catch(() => null);
        if (st) found.push({ path: p, mtime: st.mtimeMs });
      }
    }
  };
  await walk(jobsDir, 0);
  if (!found.length) return null;
  const latest = found.reduce((a, b) => (a.mtime > b.mtime ? a : b));
  const st = await fs.stat(latest.path).catch(() => null);
  return st ? { size: st.size, mtime: st.mtimeMs } : null;
}

async function stallWatch(jobsDir: string, task: string, transcriptFile: string, agent: "opencode" | "pi", stallMs: number): Promise<void> {
  const st = await transcriptStats(jobsDir, transcriptFile);
  if (!st) return; // agent hasn't started yet — never stall during env/setup
  const prev = stallState.get(jobsDir) as { size: number; frozenAt: number } | undefined;
  // live-stream rewrites the host transcript every 10s (bumping mtime even when
  // content is unchanged) — detect freeze by SIZE only.
  if (!prev || prev.size !== st.size) {
    stallState.set(jobsDir, { size: st.size, frozenAt: Date.now() });
    return;
  }
  const frozenFor = Date.now() - (prev.frozenAt ?? 0);
  if (frozenFor < stallMs) return;
  // frozen past the stall window: confirm the agent process is actually dead
  // before killing. A live agent running a long bash command (e.g. `timeout
  // 900` test run) produces no transcript growth — killing it would be a false
  // positive that discards real work.
  const container = await findContainer(task, jobsDir);
  if (!container) return;
  const pattern = agent === "pi" ? "pi --print" : "opencode --model";
  const alive = await Bun.$`docker exec ${container} sh -c 'pgrep -f ${pattern} >/dev/null && echo alive || echo dead'`.text().catch(() => "dead");
  if (alive.trim() === "alive") {
    console.log(`[cell] ${task}: transcript idle but ${agent} process alive — long command, not a stall`);
    stallState.set(jobsDir, { size: st.size, frozenAt: Date.now() }); // reset the window
    return;
  }
  console.log(`[cell] ${task}: transcript frozen and ${agent} process dead — killing container process`);
  await Bun.$`docker exec ${container} pkill -f ${pattern}`.quiet().catch(() => {});
  stallFlag.set(jobsDir, true); // triggers a fresh retry of this cell
  stallState.delete(jobsDir);
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
