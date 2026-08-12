# Bench — comprehensive benchmark for Darvh agent skills

Single home for every product's benchmark. Product repos stay clean (skills,
CLI, hooks); all harness, arms, fixtures, and results live here.

```text
arms/       arm registry (naive, signal, plain, signal+plain — context/proof added later)
harness/    one driver (harbor + docker + opencode + monitor + security)
tasks/      local adversarial starter tasks (sql, path, ratelimit)
context/    context bench record: manifest, results, docs (harness centralized here)
proof/      proof bench (Go): bench/, cmd/proofbench, conformance tests
results/    per-product results (<scope>.json)
```

## Skill distribution

Skills are NOT vendored. The recommended distribution channel is the **signal
repo's installer** (`install.sh` / `bin/install.js`): one-line, agent-agnostic,
installs `signal` + `plain` into each agent's skills dir (opencode,
claude-code, codex, cursor, copilot, antigravity). The bench resolves the
**host-installed copy** (the exact path a real agent loads) and passes it to
harbor — so the bench measures the real install + distribution path. If the
skill is missing, the harness runs the installer first (idempotent).

Universal methodology: **every cell is one harbor job** — docker image +
containerized opencode + official verifier. Arms differ ONLY by the skill
installed in the container + a one-line hint. No host tooling, no plugins, no
MCP — reproducible on any machine with docker + harbor.

## Arms (the only product-specific part)

| arm | skill installed | measures |
| --- | --- | --- |
| `naive` | — | baseline |
| `signal` | `skills/signal` | efficacy: verify, reduce uncertainty |
| `clarity` | `skills/plain` | communication |
| `signal+clarity` | both | the pair |
| `context` | — (hint: context prepare) | discovery capsule |
| `proof` | — (hint: proof verify) | verification strategy |

Skills are vendored here (pinned) so the bench is self-contained; the source
repos remain authoritative.

## Tasks

- `tb21` — the official Terminal-Bench 2.1 subset (5 tasks) via the dataset.
- `local` — adversarial starter tasks (sql injection, path traversal, rate
  limit) with a baseline check: the unmodified starter MUST fail the verifier.

## Run

```text
bun run harness/run.ts --arms naive,signal --tasks tb21 --reps 1 --split
bun run harness/run.ts --arms naive,signal --tasks local --reps 3 --split
bun run harness/monitor.ts status | stop <id|all> | watch <id>
bun run harness/monitor-agent.ts            # watchdog: auto-stop stalls
```

Security: jobs + keys live in the OS cache; the apiKey is scrubbed in place
after every run; results in `results/<scope>.json`; nothing is ever uploaded.
Per-run monitor state = one file per run (no shared-state races).

## Metrics per cell

`baseline` (starter must fail), `verdict` (official reward), `skill_used`
(proof from the session transcript that the skill was actually read),
`tokens`, `wall`.
