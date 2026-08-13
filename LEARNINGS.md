# Learnings

Field notes from building and running this bench. Hard-won lessons, not a
reference manual — the code is the source of truth; this is what the code
doesn't say.

## Infrastructure

- **Every cell = one native harbor job** (`harbor run --config`). The harness
  is a thin orchestrator: arms (skill config), per-run folders, a stall
  watchdog, live streaming, and result collection. Everything else is harbor.
- **Per-run folders**: jobs under `~/.cache/bench/<runId>/`, results under
  `results/<runId>/`. Nothing overwrites. Split children write
  `<task>-<arm>.json` per cell so parallel cells never clobber.
- **Viewing**: `harbor view <jobsDir>` is the native viewer (per-step
  trajectories, trial inspection, job compare). Custom viewers were built then
  deleted once we found it.
- **Live streaming**: harbor keeps the agent transcript inside the container
  until the trial ends. The harness polls `docker cp` of `opencode.txt` /
  `pi.txt` into `results/<runId>/live/<cell>/` every 10s so the run is
  watchable mid-flight.
- **Key hygiene**: the apiKey lives in the harbor config (0600, inside
  jobsDir), is scrubbed in place after the run, and never appears in env or
  results. For openai-compatible agents the provider env is pinned at the
  *harbor process env*, which overrides any host leak.
- **Colima**: cap at 6GB/4CPU (`--memory 6 --cpu 4`). Default 12GiB on a 18GB
  Mac = swap death + VS Code crash. Parallel cells beyond 3 on this box
  relocked it multiple times. `vmType: vz` + `rosetta: true` are on.

## Bugs found (each cost real hours)

1. **Harbor's opencode agent nests jobs** as `jobs_dir/<job_name>/<trial>/`.
   Every metrics reader that assumed one level deep returned `error`/`0 tokens`
   silently. The aggregated stats (evals, tokens) live in the **job-level**
   result.json; transcripts live in the **trial** dirs. Two different walkers.
2. **`--split` children didn't inherit flags** (`--dataset`, `--task-prefix`,
   `--agent-timeout-mult`, `--skills-src`, `--agent`, `--mode`). First split
   batch silently ran tb21 instead of swe-bench and "found no tasks".
3. **Split children clobbered each other's result file** (all shared
   `results/<runId>/<task>.json`; last writer won). Fixed with per-arm files.
4. **Result rows came from a different record than the archived result.json**
   (job-level vs trial-level). Archive now copies the job-level as
   `result.json` and the trial record as `trial.json` — row values and archive
   are the same source.
5. **Skill staging flattened into the container**: harbor does
   `cp -r <dir>/* ~/.config/opencode/skills/`, so a single skill dir dumps
   `SKILL.md` into the root and opencode never finds it. Stage the arm's
   skills under one dir, one subdir per skill, resolving host symlinks to real
   files first.
6. **opencode intermittently hangs after finishing** — the final
   `step_finish` carries `reason: "stop"`, the process never exits, and the
   cell burns the whole agent timeout (a 51-second job took 41 minutes). Root
   cause is client-side in opencode's exit path; harbor (0.21.0, latest) and
   the environment are blameless. The **stall watchdog** (transcript frozen
   5 min → `pkill opencode` in the container → harbor proceeds to the
   verifier) bounds it and still scores the verdict.
7. **The gateway (opencode.ai zen/go) intermittently stalls connections** —
   mid-run stalls and post-stop hangs are the same family. The watchdog
   catches both. Verified NOT throttling: 200 in 0.9s from inside the
   container.
8. **pi ignores `OPENAI_API_KEY`/`OPENAI_BASE_URL` entirely** — it reads its
   own credential store (a prior `pi auth` leaked a host openai key into our
   runs). The correct wiring is provider **`opencode-go`** + **`OPENCODE_API_KEY`**.
   pi also speaks the **Responses API** (`/responses`), which zen/go does serve
   for `deepseek-v4-flash` (the docs table was incomplete).

## Agent results (django__django-11099, all pass)

| agent | arm | mode | tokens | cost |
|---|---|---|---|---|
| opencode | naive | — | 149-152k | $1.3-1.5m |
| opencode | signal | skill | 157.9k | $2.28m |
| pi | signal | skill-tool | 106.9k | $2.24m |
| pi | signal | always-on (pre-refine) | 119.3k | $2.40m |
| pi | signal | always-on (refined) | 82.1k | $1.72m |
| pi | clarity | always-on | 90.4k | $1.74m |
| pi | caveman | always-on | 77.6k | $1.55m |
| pi | ponytail | always-on | 84.7k | $1.56m |

Other tasks: `cancel-async-tasks` (tb21) pass; `build-pmars` (tb21) pass;
`crack-7z-hash` (tb21) **naive fails** (315k tok, 31 min — the discriminator).

## Skills — the adoption problem (the headline finding)

- Skills are **installed, registered, and visible in-context** — proven:
  `opencode debug skill` lists them, the model quotes the `<available_skills>`
  block verbatim, and pi reports "Available skills: signal" when asked.
- Yet **autonomous adoption is ~0%**: neither opencode nor pi's model invokes
  the on-demand skill tool, even on hard tasks where they fail (crack-7z-hash
  burned 251k tokens stuck, never reaching for signal).
- **The fix is always-on injection**: mount the whole skill dir into the task
  cwd (`/testbed/.signal`) + an AGENTS.md pointer. Both agents then *read*
  the skill (`cat /testbed/.signal/SKILL.md`) and follow it. This is the
  caveman/ponytail model — rules injected every session, not an opt-in tool.
- **Doctrines in practice** (pi, django): signal added regression tests and
  proved they were meaningful (falsifying check); ponytail called the fix
  "trivial" and did the minimum. Same verdict; signal cost ~35k more tokens on
  verification. Refining signal's *verification discipline* (verify once,
  decisively, with a meaningful falsifying check; stop when evidence decides)
  cut its run 119k → 82k tokens with the same pass.

## Result hygiene (why rows get removed)

Not every row is a valid completion. The stall watchdog kills agents whose
transcript freezes >5 min — the agent pipeline then exits nonzero and harbor
records `NonZeroAgentExitCodeError`. The verifier still runs (and can pass),
but the row is a **truncated run**: the token count reflects work cut short by
the watchdog, not a finished agent. These are removed from comparisons.

Removed rows (django__django-11276, pi, always-on, full budget):

| arm | rep | verdict | tokens | exc | why |
|---|---|---|---|---|---|
| naive | r3 | pass | 500,775 | NonZero | watchdog kill |
| caveman | r1 | pass | 1,281,198 | NonZero | watchdog kill |
| caveman | r2 | pass | 200,074 | NonZero | watchdog kill |
| ponytail | r2 | fail | 625,319 | NonZero | watchdog kill + failed |
| ponytail | r3 | pass | 2,818,933 | NonZero | watchdog kill |
| signal | r1 | pass | 1,737,879 | NonZero | watchdog kill |
| signal | r3 | pass | 1,023,739 | NonZero | watchdog kill |

Clean set kept (exception `clean`):

| arm | tokens |
|---|---|
| naive r1 / r2 | 1,024,462 / 1,272,146 |
| caveman r3 | 1,067,693 |
| ponytail r1 | 3,245,020 |
| signal r2 | 821,176 |

Watchdog-kill rate was high (~5 of 9) — the agent often freezes after finishing
its edits (the opencode/pi hang), so the kill is common but the fix is usually
complete enough to pass. **Lesson**: a clean `verdict` is NOT a clean run; check
`exception_type` before trusting token counts. The huge per-rep spread (200k →
3.2M) across all arms also means n=1 per arm is meaningless — this needs many
reps and medians.

## Cost model

Cost = `(n_input − n_cache) × $0.14 + n_cache × $0.0028 + n_output × $0.28` per
1M. Harbor's `n_input_tokens` includes cache-reads, so the miss term is the
difference. Verified to the penny against row values (92.9% cache-hit example:
$0.002397 exact).

## Operating rules

- **No kill storms.** `docker kill $(docker ps -q)`, mass `pkill`, `monitor
  stop all` while docker is under load each crashed VS Code / locked the box.
  Stop runs one at a time or let the watchdog do it.
- **Launch cells detached** (`nohup ... &`) and poll `monitor.ts done` — the
  foreground command keeps getting interrupted and the interrupt itself kills
  the trial (CancelledError).
- **tb21 cells are 3-31 min** (task-defined agent timeouts + slow verifiers);
  swe-bench cells 2-8 min with the timeout multiplier at 0.4.
- **Rosetta is on** (colima `vz` + `rosetta: true`); native builds are arm64,
  rosetta only matters for amd64-only images harbor explicitly requests.

## x86 images under rosetta (SWE-bench)

SWE-bench eval images are amd64-only (`swebench/sweb.eval.x86_64.*`). Colima
arm64 + harbor's compose build (daemon platform) fails with "no match for
platform in manifest". Fix: patch harbor's
`environments/docker/docker-compose-build.yaml` — add `platform: linux/amd64`
to the `main` service (rosetta builds/runs it). Re-apply after every harbor
reinstall.
