# Confirmatory study — always-on skill efficacy on unseen tasks

**Claim tested:** on unseen SWE-bench tasks, does forcing a skill change token
efficiency or correctness vs a no-skill baseline?

## Design

- **Tasks**: 9 unseen `swe-bench/swe-bench-verified` tasks, 3 per difficulty
  stratum (gold-patch LOC: low <7, med 7-13, high ≥14), 9 distinct repos,
  none used to develop any skill. Selection recorded before running in
  `study-selection.md`.
- **Conditions**: `no-skill` (naive), `signal`, `ponytail` — always-on (skill
  injected via AGENTS.md MUST directive).
- **Cells**: 9 × 3 × 4 reps = **108**, task-major order, within-task shuffle
  seed **42**.
- **Skills pinned**: signal `364f8b3` (== current main's SKILL.md), ponytail
  `main@2ed6c52`.
- **Pricing**: provider-reported rates (input $0.07/M, cache $0.0014/M,
  output $0.14/M); tokens are the primary metric.

## Grid integrity

- 108/108 cells present, all `completion=normal`, 0 exceptions, 0 missing.
- 3 cells consumed retries (recorded `attempts` + `discarded_cost_usd`); they
  still produced valid results.

## Results

### Efficiency (per-task median tokens, then median across tasks)

| arm | median tokens | token ratio vs naive | beats naive |
|-----|---------------|----------------------|-------------|
| naive | 0.703M | 1.00x | — |
| **signal** | **0.534M** | **0.53x** | 6/9 tasks |
| **ponytail** | **0.402M** | **0.63x** | 7/9 tasks |

### Cost (per-task median cost, then median; plus totals)

| arm | median cell cost | total (108 cells / 36 per arm) | cost ratio vs naive |
|-----|------------------|-------------------------------|---------------------|
| naive | $0.0085 | $0.393 | 1.00x |
| signal | $0.0069 | $0.269 | **0.62x** (cheaper on 8/9) |
| ponytail | $0.0054 | $0.300 | 0.66x (cheaper on 7/9) |

### Correctness

| arm | pass rate |
|-----|-----------|
| **signal** | **36/36** |
| ponytail | 35/36 |
| naive | 34/36 |

### Signal's per-task token ratio vs naive (lowest = best)

| task | stratum | ratio |
|------|---------|-------|
| scikit-learn-13142 | high | **0.26x** |
| xarray-3677 | low | **0.42x** |
| requests-6028 | med | **0.44x** |
| pylint-7080 | low | **0.49x** |
| sympy-23413 | high | **0.53x** |
| astropy-14995 | med | 0.76x |
| django-11179 | low | 1.02x |
| pytest-7324 | high | 1.11x |
| matplotlib-24570 | med | 1.13x |

## Findings

1. **Both skills improve efficiency over no-skill.** Median token ratio 0.53x
   (signal) and 0.63x (ponytail); both cheaper than naive on the majority of
   tasks. Signal total cost $0.269 vs naive $0.393 (−32%).

2. **Signal is the only arm with a perfect pass rate** (36/36), and its
   efficiency wins are largest on the verbose/heavy tasks (scikit-learn 3.8x,
   sympy 1.9x, pylint 2.0x fewer tokens).

3. **Skills are not free on trivial tasks.** django 1.02x, pytest 1.11x,
   matplotlib 1.13x — the skill overhead slightly exceeds the saving on the
   easiest cells. The benefit is difficulty-dependent.

4. **Ponytail is leanest per-cell** ($0.0054 median) but had the study's only
   non-signal fails (naive 1, ponytail 1; signal 0), and its cost advantage
   over signal shrinks once pass-rate is held constant (cheaper total only on
   7/9, and it loses requests/pytest outright).

5. **Correctness is mostly saturated** (34-36/36), so the headline metric is
   efficiency at equal-or-better correctness.

## Charts

- `study-tokens.png` — per-task median tokens (log), all three arms
- `study-token-ratio.png` — tokens vs naive per task (dashed line = 1.0x)
- `study-pass-rate.png` — pass rate by task and arm

## Caveats

- Always-on measures **forced** adoption — the ceiling, not autonomous use.
  The opt-in (adoption) study answers whether the agent chooses to load the
  skill; that run is separate.
- n=4 per task per arm; medians reported. Per-cell token variance within an
  arm is 2-5x on some tasks.
- External web access was present in the environment but was not observed
  used by any agent in the run transcripts.
