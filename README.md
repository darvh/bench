# bench

Single home for every product's benchmark. Product repos stay clean (skills,
CLI, hooks); all harness, arms, fixtures, and results live here.

```text
arms/       arm registry (naive, signal, clarity, signal+clarity, caveman, ponytail, and pairs)
harness/    one driver (harbor + docker + opencode + monitor + security)
results/    per-run results (<runId>/tb21.json + sessions + trajectory.html)
```

Context and proof bench records moved out to `../bench-archive/` for now; the
unified harness covers their arms when needed — no duplication.

## Skill distribution

Skills are NOT vendored. The recommended distribution channel is the **signal
repo's installer** (`install.sh` / `bin/install.js`): one-line, agent-agnostic,
installs `signal` + `clarity` into each agent's skills dir (opencode,
claude-code, codex, cursor, copilot, antigravity). The bench resolves the
**host-installed copy** (the exact path a real agent loads) and passes it to
harbor — so the bench measures the real install + distribution path. If the
skill is missing, the harness runs the installer first (idempotent).

Universal methodology: **every cell is one harbor job** — docker image +
containerized opencode + official verifier. Arms differ ONLY by the skill
installed in the container — no prompt hints, no host tooling, no plugins, no
MCP. The task prompt is identical across arms, so the bench measures whether
the agent autonomously adopts and benefits from the skill. Reproducible on any
machine with docker + harbor.

## Arms (the only product-specific part)

| arm | skill installed | measures |
| --- | --- | --- |
| `naive` | — | baseline |
| `signal` | `skills/signal` | efficacy + autonomous adoption |
| `clarity` | `skills/clarity` | communication + autonomous adoption |
| `signal+clarity` | both | the pair |
| `caveman` | `skills/caveman` | terse-prose control |
| `ponytail` | `skills/ponytail` | minimal-code control |
| `caveman+ponytail` | both | the pair |

Skills are NOT vendored: each cell resolves the host-installed copy (the exact
path a real agent loads) and stages it into the container under its proper
`<skills>/<name>/SKILL.md` layout; the source repos remain authoritative.

## Tasks

- `tb21` — the official Terminal-Bench 2.1 subset (5 tasks) via the dataset
  (`crack-7z-hash`, `cancel-async-tasks`, `compile-compcert`, `circuit-fibsqrt`,
  `build-pmars`).
- Any single task name from the dataset, e.g. `--tasks crack-7z-hash`.

## Run

```text
bun run harness/run.ts --arms naive,signal --tasks tb21 --reps 1 --split
bun run harness/run.ts --arms naive,signal --tasks crack-7z-hash --reps 3
bun run harness/monitor.ts status | stop <id|all> | watch <id> | done
bun run harness/monitor-agent.ts            # watchdog: auto-stop stalls
```

Security: jobs + keys live in the OS cache; the apiKey is scrubbed in place
after every run; results in `results/<runId>/`; nothing is ever uploaded.
Per-run monitor state = one file per run (no shared-state races).

## Metrics per cell

`verdict` (official reward), `skill_used` (proof from the session transcript
that the skill was actually loaded), `tokens`, `cost_usd` (at the DeepSeek V4
Flash price schedule), `wall`. Sessions (trajectory + results) land in
`results/<runId>/sessions/` and `harness/session.ts` prints the per-step view;
`harness/viz.ts` renders a local HTML timeline.
