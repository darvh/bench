# Confirmatory study — task selection

Recorded **before** running. Evaluation-leakage control: none of these tasks were
used to refine the Signal skill. All are unseen.

## Selection procedure

1. Pulled all 500 `swe-bench/swe-bench-verified` tasks.
2. Difficulty = objective gold-patch size: `loc` = added/deleted lines in the
   gold `solve.sh` patch, `files` = files touched.
3. Excluded every task used in pilot/refinement runs:
   `django-11099/11276/16560/16938`, `astropy-13977/7336`,
   `sympy-13878/15976/16597`, `xarray-7233`, `pytest-5787`, `sphinx-10614`.
4. Stratified remaining 488 tasks into thirds by `loc`: low < 7, med 7-13, high ≥ 14.
5. Greedy pick 3 per stratum, constraining ≤ 2 tasks per repository and
   maximizing repository spread (prefer repo not yet picked).

## Selected tasks

| stratum | task | loc | files | repo |
|---------|------|-----|-------|------|
| low | `django__django-11179` | 4 | 1 | django |
| low | `pydata__xarray-3677` | 4 | 1 | pydata |
| low | `pylint-dev__pylint-7080` | 4 | 1 | pylint-dev |
| med | `astropy__astropy-14995` | 7 | 1 | astropy |
| med | `matplotlib__matplotlib-24570` | 7 | 1 | matplotlib |
| med | `psf__requests-6028` | 7 | 1 | psf |
| high | `scikit-learn__scikit-learn-13142` | 14 | 1 | scikit-learn |
| high | `sympy__sympy-23413` | 14 | 1 | sympy |
| high | `pytest-dev__pytest-7324` | 15 | 1 | pytest-dev |

9 distinct repositories, ≤ 1 task per repo, 3 per difficulty stratum.

## Conditions

| condition | mode | notes |
|-----------|------|-------|
| no-skill | baseline | no-skill arm (control) |
| signal | always-on | efficacy ceiling |
| ponytail | always-on | active-efficiency competitor |

Cells randomized task-major, within-task order shuffled with seed **42**
(`--seed 42`), all arms of a task run in the same time window.

Skill commits pinned: signal `364f8b350c8b11234ce16cb81835d4bf4c40d47a`,
ponytail `2ed6c52c9d7e5e56942508591085fd45dea277d3`.

## Counts

- Main efficacy: 9 tasks × 3 conditions × 4 reps = **108 cells**
- Adoption study (separate run): 6 tasks × 2 skills × 3 reps opt-in = **36 cells**
