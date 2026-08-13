# Tiered benchmark — SWE + tb21 across difficulty (2026-08-13)

4 arms × 6 tasks (3 tiers × tb21/swe). Every cell `completion=normal` except
one documented stall-retry. Time is excluded (network variance) — cost & tokens
are the metrics.

## Skill-load reference (fragments included)

| skill | files | est. load tokens |
|---|---|---|
| signal | 7 (SKILL.md + 6 fragments) | 2,067 |
| caveman | 2 | 2,028 |
| ponytail | 1 | 1,659 |

These are the token costs of reading the skill content (via the mounted
AGENTS.md pointer) — the "cost of using the skill" added to every skill-arm
cell. They're ~1-2% of typical totals; a fixed reference, not noise.

## Results (tokens · cost)

### LOW

**tb21 cancel-async-tasks**

| arm | verdict | tokens | cost |
|---|---|---|---|
| **signal** | **pass** | 184,106 | 0.0052 |
| caveman | fail | 51,649 | 0.0026 |
| ponytail | fail | 26,312 | 0.0015 |
| naive | fail | 8,006 | 0.0007 |

**swe django-11099**

| arm | verdict | tokens | cost |
|---|---|---|---|
| **signal** | pass | 57,439 | 0.0013 |
| caveman | pass | 60,635 | 0.0012 |
| naive | pass | 76,426 | 0.0017 |
| ponytail | pass | 160,454 | 0.0024 |

### MED

**tb21 build-pmars**

| arm | verdict | tokens | cost |
|---|---|---|---|
| **caveman** | pass | 161,466 | 0.0027 |
| ponytail | pass | 199,273 | 0.0036 |
| signal | pass | 250,751 | 0.0042 |
| naive | pass | 282,735 | 0.0043 |

**swe django-11276**

| arm | verdict | tokens | cost |
|---|---|---|---|
| **naive** | pass | 741,247 | 0.0088 |
| signal | pass | 864,860 | 0.0101 |
| caveman | pass | 958,682 | 0.0099 |
| ponytail | pass | 2,139,148 | 0.0165 |

### HIGH

**tb21 crack-7z-hash** — nobody passes (password uncracked)

| arm | verdict | tokens | cost |
|---|---|---|---|
| naive | fail | 94,464 | 0.0014 |
| ponytail | fail | 116,942 | 0.0018 |
| signal | fail | 184,386 | 0.0030 |
| caveman | fail | 673,040 | 0.0088 |

**swe sympy-13878**

| arm | verdict | tokens | cost |
|---|---|---|---|
| **ponytail** | pass | 2,616,684 | 0.0208 |
| caveman | pass | 3,007,133 | 0.0255 |
| naive | pass | 4,764,066 | 0.0344 |
| signal | pass | 6,391,477 | 0.0417 |

## How each arm got there (key cells)

**cancel-async-tasks — the one verdict flip.** naive did *nothing* (8k tokens,
failed without real effort). signal actually worked the concurrency semantics
and passed. caveman/ponytail made partial attempts (26-52k) and failed.

**sympy-13878 — the reversal.** ponytail was cheapest (2.6M) — minimal
targeted edits on the distribution-CDF issue. signal was most expensive
(6.4M) — heavy verification/exploration this run (note: signal ran 2.5M on
this task in the earlier matrix; the 6.4M is the n=1 swing).

**django-11276 — the case study** (from the earlier transcript analysis):
signal = authority-first (identify the ticket, apply the canonical fix, verify
once); caveman = minimal + "expected fallout" recognition; naive = iterate
tests chasing failures; ponytail = explore-the-landscape then methodical.

**crack-7z-hash — everyone fails.** The task ceiling is the discriminator
naive can't cross; caveman burned the most trying (673k).

## Reading it honestly

1. **No arm dominates.** signal wins the flip (cancel) and the cheap-easy
   (django-11099), but loses sympy (most expensive) and crack. ponytail wins
   sympy but fails cancel/crack. caveman wins build-pmars.
2. **Verdict flips are rare** — only cancel-async differentiated (signal pass,
   others fail); crack is a floor nobody clears.
3. **n=1 variance swamps differences.** signal on sympy: 2.5M → 6.4M across
   two runs. The token gaps within a task are often smaller than the
   run-to-run swing. Nothing here is statistically solid at n=1.
4. **Skill-load overhead is real but tiny** (1.6-2.1k tokens) — never explains
   the gaps.
5. **The honest conclusion:** the bench now measures arms across difficulty,
   and the signal is "no clear winner, high variance, one flip" — which is a
   defensible, unflattering finding. Reps ≥5 on the discriminating tasks
   (cancel, sympy, crack) would be the next step to pin it down.
