# Skill benchmark interpretation

What the numbers mean, how to read the charts, and what the data actually shows.

## Setup

- **Tasks**: one per difficulty tier from `swe-bench/swe-bench-verified`
  - **Low**: `django__django-11099` — one-file validator tweak
  - **Medium**: `astropy__astropy-13977` — real cross-file change
  - **High**: `sympy__sympy-13878` — deep library fix (CDF distribution code)
- **Arms**: `no-skill` (no skill) · `signal` · `ponytail` · `signal+ponytail` (both skills)
- **Mode**: always-on (skill content injected via AGENTS.md MUST directive — the skill is guaranteed present)
- **Reps**: 2 per arm per task; 24 cells total; every cell `completion=normal`
- **Model**: opencode-go `deepseek-v4-flash`, pricing fixed to provider-reported rates

## Charts

- `skill-cost.png` — median cost per cell by arm and difficulty (log scale)
- `skill-token-ratio.png` — tokens vs no-skill baseline (lower is better)
- `skill-pass-rate.png` — correctness (saturated at ~100%)

## What each chart shows

### `skill-cost.png` — median cost per tier (log scale)

- Y axis is **log-scaled** because Low-tier costs (~$0.001) are 50x smaller than High-tier costs (~$0.05).
- Bar value = median USD across reps for that arm at that difficulty.
- **Read it as**: how much money the skill costs/ saves at each difficulty.

### `skill-token-ratio.png` — token efficiency vs no-skill

- Each bar = `median tokens(arm) / median tokens(no-skill)` at that tier.
- The dashed line at **1.0x = no-skill** (baseline).
- Below the line = the skill used fewer tokens than no-skill; above = it used more.
- **Read it as**: the skill's token leverage (or tax) at each difficulty.

## The objective findings

1. **Signal's value scales with difficulty.**
   - High tier: 0.20x no-skill (2.01M vs 10.25M tokens), cost $0.019 vs $0.058 — **~3x cheaper, ~5x fewer tokens, same pass rate (2/2)**.
   - Medium tier: 0.67x tokens, still cheaper than no-skill.
   - Low tier: 2.33x tokens — pure overhead, no benefit.

2. **Skills are overhead on easy tasks.** All three skill arms cost 2.3–3.7x no-skill's tokens on the Low task with identical outcome (everyone passes). On trivial work the skill's reading + following is wasted motion.

3. **The pair wins mid-tier, loses high-tier.** `signal+ponytail` is cheapest on Medium (0.31x no-skill, $0.0086) — signal scopes, ponytail minimizes. But on High it degrades to 0.82x (grinds like ponytail under the heavy test loop), erasing the pair advantage.

4. **Ponytail alone is the weakest skill.** Only 0.55x on High, and it grinds longest (largest wall times, most stalls) — minimalism without a verification gate disperses effort across files instead of converging.

## Honest caveats

- **n=2** per cell. Token swings of 2–5x within an arm are common (signal's High-tier range was 1.9–4.4M across reps). Medians damp this but don't remove it.
- **Pass rate is saturated** — every kept cell passed, so the benchmark measures *efficiency at equal correctness*, not correctness itself. A task with flips (e.g. sphinx-10614) would be needed to compare who *passes more*.
- **Stall-watchdog fixed mid-run**: two early High-tier cells were false-killed by a transcript-idle heuristic that couldn't tell a long-running test from a hang. Rerun with the liveness check + higher timeout; the retries both passed.
- Always-on measures *forced* adoption. In opt-in mode (not charted here) the model almost never loads the skills, so the pair's benefit disappears entirely.

## One-line summary

**Skills are a tax on easy problems and a discount on hard ones — signal delivers the cleanest discount (3x cheaper at equal pass on the hardest task); the signal+ponytail pair is best mid-difficulty but doesn't hold up on the hardest work.**
