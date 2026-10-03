# Contamination audit — 2026-08-16 confirmatory run

Found 2026-10-03 while checking the study's "external web access ... not
observed used" caveat. That caveat was **false**. The dataset images allow
public egress during the agent phase, and **37 of 108 cells executed commands
that fetched external URLs; all 37 passed**. Eight fetched a fix artifact
(PR diff, fix commit, fix changelog, or post-fix main source); seven cloned an
upstream repo whose history contains the fix; the rest pulled upstream sources,
issues/commits, or version docs.

Method: parse every live transcript
(`results/2026-08-16T05-04-57-241Z/live/<cell>/pi.txt`) as JSONL, take
`tool_execution_start` commands containing a network tool (`curl`, `wget`,
`git clone/fetch/ls-remote`, `pip install`, `urllib`, ...) and an `http(s)://`
URL. Verdicts from the run result JSON. `strongest command` = highest-priority
match (fix artifact > raw source > clone > GitHub API > docs).

| arm | task | rep | verdict | strongest command | class |
|---|---|---|---|---|---|
| no-skill | psf__requests-6028 | 1 | pass | `curl -s --max-time 15 "https://api.github.com/search/issues?q=repo:psf/requests+407+3.8.12" | python -c " import json,sys d=json.load(sys.stdin) for i` | GitHub API |
| no-skill | psf__requests-6028 | 2 | pass | `curl -sL --max-time 20 "https://patch-diff.githubusercontent.com/raw/psf/requests/pull/6028.diff" | head -200` | fix PR diff |
| no-skill | psf__requests-6028 | 3 | pass | `cd /tmp && curl -s --max-time 15 https://raw.githubusercontent.com/psf/requests/v2.27.1/HISTORY.md | head -40` | upstream source |
| no-skill | psf__requests-6028 | 4 | pass | `curl -s --max-time 20 "https://api.github.com/search/issues?q=repo:psf/requests+proxy+407+in:title" 2>/dev/null | python3 -c " import sys, json try:  ` | GitHub API |
| no-skill | pylint-dev__pylint-7080 | 1 | pass | `timeout 20 curl -s "https://api.github.com/repos/pylint-dev/pylint/issues/7084" 2>/dev/null | python -c "import json,sys; d=json.load(sys.stdin); prin` | GitHub API |
| no-skill | pylint-dev__pylint-7080 | 2 | pass | `cd /tmp && timeout 20 curl -s "https://raw.githubusercontent.com/PyCQA/pylint/v2.15.0/doc/whatsnew/2.15.rst" -o w215.rst && grep -n -i "ignore-path\|r` | upstream source |
| no-skill | pylint-dev__pylint-7080 | 3 | pass | `curl -s --max-time 10 "https://api.github.com/search/issues?q=repo:PyCQA/pylint+recursive+ignore-paths+in:title" 2>/dev/null | python -c " import json` | GitHub API |
| no-skill | pylint-dev__pylint-7080 | 4 | pass | `cd /tmp && curl -sL https://raw.githubusercontent.com/pylint-dev/pylint/v2.15.0/tests/lint/unittest_lint.py -o unittest_lint_215.py && grep -n "recurs` | upstream source |
| no-skill | pytest-dev__pytest-7324 | 1 | pass | `cd /tmp && git clone --quiet --filter=blob:none --no-checkout https://github.com/pytest-dev/pytest.git pytest_full 2>&1 | tail -2; cd pytest_full && g` | upstream clone |
| no-skill | pytest-dev__pytest-7324 | 2 | pass | `curl -s https://raw.githubusercontent.com/pytest-dev/pytest/6.0.1/doc/en/changelog.rst 2>/dev/null | sed -n '/^6.0.1/,/^6.0.0/p' | grep -n -i "debug\|` | upstream source |
| no-skill | pytest-dev__pytest-7324 | 4 | pass | `git clone pytest, then git show 1deaa7434 (the fix commit)` | fix commit |
| ponytail | psf__requests-6028 | 1 | pass | `curl -s "https://raw.githubusercontent.com/python/cpython/v3.8.12/Misc/NEWS.d/next/Security/2021-08-10-21-14-14.bpo-43921.zmJcNo.rst" 2>/dev/null; ech` | upstream source |
| ponytail | psf__requests-6028 | 2 | pass | `curl -s --max-time 15 "https://api.github.com/search/commits?q=repo:psf/requests+407+proxy" 2>/dev/null | grep -E '"message"|"html_url"' | head -20` | GitHub API |
| ponytail | psf__requests-6028 | 3 | pass | `curl -s --max-time 15 "https://raw.githubusercontent.com/psf/requests/v2.27.1/requests/utils.py" | sed -n '/def prepend_scheme_if_needed/,/return urlu` | upstream source |
| ponytail | psf__requests-6028 | 4 | pass | `cd /tmp && for v in 3.8.11 3.8.12; do curl -sL https://raw.githubusercontent.com/python/cpython/v$v/Lib/urllib/parse.py -o parse_$v.py; done && diff p` | upstream source |
| ponytail | pylint-dev__pylint-7080 | 1 | pass | `curl -s "https://api.github.com/repos/pylint-dev/pylint/commits?path=pylint/lint/expand_modules.py&per_page=100" | python3 -c " import json,sys data =` | GitHub API |
| ponytail | pylint-dev__pylint-7080 | 2 | pass | `git fetch pylint pull/7080/head, then git diff 3c5eca2d FETCH_HEAD` | fix PR head |
| ponytail | pylint-dev__pylint-7080 | 3 | pass | `cd /tmp && curl -sL "https://patch-diff.githubusercontent.com/raw/pylint-dev/pylint/pull/7080.diff" 2>/dev/null | head -200` | fix PR diff |
| ponytail | pylint-dev__pylint-7080 | 4 | pass | `curl -s --max-time 10 "https://api.github.com/search/issues?q=repo:pylint-dev/pylint+recursive+ignore-paths+in:title" 2>&1 | head -30` | GitHub API |
| ponytail | pytest-dev__pytest-7324 | 1 | pass | `curl raw.githubusercontent.com/pytest-dev/pytest/6.2.3/changelog/7322.bugfix.rst` | fix changelog |
| ponytail | pytest-dev__pytest-7324 | 2 | pass | `cd /tmp && timeout 120 git clone --filter=blob:none --no-checkout https://github.com/pytest-dev/pytest.git pytest-git 2>&1 | tail -2` | upstream clone |
| ponytail | pytest-dev__pytest-7324 | 3 | pass | `curl -s https://raw.githubusercontent.com/pytest-dev/pytest/6.2.1/doc/en/changelog.rst | grep -n "40870\|8174\|True.*False.*None" | head` | upstream source |
| ponytail | sympy__sympy-23413 | 1 | pass | `cd /tmp && timeout 30 git clone --depth 1 https://github.com/sympy/sympy.git sympy-upstream 2>&1 | tail -2` | upstream clone |
| signal | matplotlib__matplotlib-24570 | 3 | pass | `cd /tmp && timeout 20 curl -sL https://raw.githubusercontent.com/matplotlib/matplotlib/v3.7.0/lib/matplotlib/offsetbox.py -o off_v370.py 2>&1; echo "e` | upstream source |
| signal | matplotlib__matplotlib-24570 | 4 | pass | `curl patch-diff.githubusercontent.com/raw/matplotlib/matplotlib/pull/24529.diff` | fix PR diff |
| signal | psf__requests-6028 | 1 | pass | `curl -s --max-time 15 "https://api.github.com/search/issues?q=repo:psf/requests+407+3.8.12" | python3 -c " import json,sys d=json.load(sys.stdin) for ` | GitHub API |
| signal | psf__requests-6028 | 2 | pass | `curl -sL --max-time 20 "https://patch-diff.githubusercontent.com/raw/psf/requests/pull/6028.diff" | head -200` | fix PR diff |
| signal | psf__requests-6028 | 3 | pass | `curl -s "https://raw.githubusercontent.com/python/cpython/3.8/Doc/whatsnew/3.8.rst" | grep -n -A 40 "3.8.12" | head -80` | upstream source |
| signal | psf__requests-6028 | 4 | pass | `timeout 20 python -c " import urllib.request, json req = urllib.request.Request('https://api.github.com/repos/psf/requests/issues/6108', headers={'Use` | GitHub API |
| signal | pylint-dev__pylint-7080 | 1 | pass | `cd /tmp && timeout 8 python -c " import urllib.request try:     r = urllib.request.urlopen('https://raw.githubusercontent.com/pylint-dev/pylint/2.15.0` | upstream source |
| signal | pylint-dev__pylint-7080 | 2 | pass | `cd /tmp && rm -rf pylint-upstream && timeout 300 git clone --bare --filter=blob:none https://github.com/pylint-dev/pylint.git pylint-upstream 2>&1 | t` | upstream clone |
| signal | pylint-dev__pylint-7080 | 3 | pass | `cd /tmp && git clone -q --filter=blob:none https://github.com/pylint-dev/pylint.git pylint-git 2>&1 | tail -1; cd pylint-git && git log --oneline --al` | upstream clone |
| signal | pylint-dev__pylint-7080 | 4 | pass | `cd /tmp && timeout 60 git clone --depth 1 -q https://github.com/pylint-dev/pylint.git pylint-main 2>&1 | tail -1; ls pylint-main/tests/lint/unittest_l` | upstream clone |
| signal | pytest-dev__pytest-7324 | 1 | pass | `cd /tmp && curl -s "https://api.github.com/search/commits?q=repo:pytest-dev/pytest+IDENT_PREFIX" -H "Accept: application/vnd.github.cloak-preview" 2>/` | GitHub API |
| signal | pytest-dev__pytest-7324 | 3 | pass | `curl raw.githubusercontent.com/pytest-dev/pytest/main/src/_pytest/mark/expression.py` | upstream source (post-fix main) |
| signal | pytest-dev__pytest-7324 | 4 | pass | `cd /tmp && git clone --filter=blob:none --no-checkout -q https://github.com/pytest-dev/pytest.git pytest-git 2>&1 | tail -2; cd pytest-git && git log ` | upstream clone |
| signal | sympy__sympy-23413 | 1 | pass | `cd /testbed && timeout 30 python -c " import urllib.request url = 'https://raw.githubusercontent.com/sympy/sympy/master/sympy/polys/matrices/normalfor` | upstream source |

## Impact

- Contaminated cells: no-skill 11/36, ponytail 12/36, signal 14/36. All passed.
- Clean-only pass rates: **signal 22/22, ponytail 23/24, no-skill 23/25**.
- Clean-only token ratio vs no-skill (median of per-task medians): signal 0.75x, ponytail 0.46x — the ordering flips vs the contaminated table (signal 0.53x, ponytail 0.63x). Some tasks have a single clean cell after exclusion, so this is a sensitivity, not a result.

## Remedy

- The harness now materializes every dataset task (`harbor download --export`)
  and patches `[agent] network_mode = "allowlist"` with
  `allowed_hosts = ["opencode.ai", "*.opencode.ai", "models.dev"]` — the agent
  phase can reach the model gateway and nothing else; agent install keeps the
  public baseline for npm.
- Every result row records `network_used`, a transcript canary that flags
  network commands without a blocked-egress error; the run provenance records
  `agentNetworkPolicy`.
- `results/confirmatory-study.md` marks the efficiency/cost tables as
  contaminated and needs a clean rerun before they are treated as
  confirmatory.
