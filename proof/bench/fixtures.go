package bench

import (
	"fmt"
)

// Fixture file templates. Each class is one row in the table below; the
// builder materializes real git repositories at runtime.

const pyRunner = `#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
if python3 -m unittest discover -s tests -q >/dev/null 2>&1; then
  echo '<testsuites><testsuite name="native" tests="1" failures="0"><testcase name="native tests pass"/></testsuite></testsuites>'
  exit 0
fi
echo '<testsuites><testsuite name="native" tests="1" failures="1"><testcase name="native tests pass"><failure message="native tests fail"/></testcase></testsuite></testsuites>'
exit 1
`

const sleepyTool = `#!/bin/sh
sleep 1
exit 0
`

const lcovPartial = `#!/bin/sh
cat <<'EOF'
TN:
SF:src/svc.py
DA:2,1
end_of_record
EOF
`

// initPy puts the repository root on sys.path so `from src import ...` works.
const initPy = "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\n"

const srcInit = ""

func helpsFixture() *Task {
	// Redesigned so proof's mechanism is the discriminating factor.
	// The None edge is: NOT handled correctly in base code, NOT named in the
	// intent (both arms see the same intent), and only exposed to the
	// proof-armed agent via the behavior obligation (red/green required).
	// Without proof: the agent satisfies the visible suite (expired + valid)
	// and never considers None -> hidden test fails -> false-green.
	// With proof: the obligation forces writing the None test -> observed red
	// on the buggy code -> None guard added -> green -> hidden passes.
	return &Task{
		Class:  ClassHelps,
		ID:     "help",
		Intent: "authorize() currently accepts some invalid sessions; make the session rejection logic correct",
		Policy: `version: 1
behaviors:
  - id: rejects-expired-session
    statement: Rejects an expired session
    scope: ["src/**"]
    evidence:
      red: required
      green: required
  - id: rejects-none-session
    statement: Rejects a None session instead of accepting it
    scope: ["src/**"]
    evidence:
      red: required
      green: required
checks:
  unit:
    run: [./test/run.sh]
    test_format: junit
policies:
  - match: ["src/**"]
    require: [unit, rejects-expired-session, rejects-none-session]
`,
		Base: []File{
			{Path: "src/__init__.py", Content: srcInit},
			// expired handled; None is wrongly ACCEPTED (clean assertion red,
			// not a crash — proof's red evidence needs a failing test, not an error)
			{Path: "src/session.py", Content: "def authorize(session):\n    if session is None:\n        return True\n    return not session.get(\"expired\", False)\n"},
			{Path: "tests/__init__.py", Content: initPy},
			{Path: "tests/test_session.py", Content: "import unittest\nfrom src import session\n\nclass TestSession(unittest.TestCase):\n    def test_authorizes_valid(self):\n        self.assertTrue(session.authorize({\"expired\": False}))\n"},
			{Path: "tests/test_expiry.py", Content: "import unittest\nfrom src import session\n\nclass TestExpiry(unittest.TestCase):\n    def test_rejects_expired(self):\n        self.assertFalse(session.authorize({\"expired\": True}))\n"},
			{Path: "test/run.sh", Content: pyRunner},
		},
		Proposed: []File{
			// Looks complete (visible suite passes) but still accepts None:
			// the hidden strict test catches it.
			{Path: "src/session.py", Content: "def authorize(session):\n    if session is None:\n        return True\n    if session.get(\"expired\", False):\n        return False\n    return True\n"},
		},
		Gold: []File{
			{Path: "src/session.py", Content: "def authorize(session):\n    if session is None:\n        return False\n    if session.get(\"expired\", False):\n        return False\n    return True\n"},
		},
		// The hidden strict test: the None edge only the obligation exposes.
		HiddenTests: []File{
			{Path: "tests/test_expiry_strict.py", Content: "import unittest\nfrom src import session\n\nclass TestExpiryStrict(unittest.TestCase):\n    def test_rejects_none(self):\n        self.assertFalse(session.authorize(None))\n    def test_rejects_expired(self):\n        self.assertFalse(session.authorize({\"expired\": True}))\n"},
		},
		GoldObligations: []string{"rejects-expired-session", "rejects-none-session"},
	}
}

func bothOKFixture() *Task {
	return &Task{
		Class:  ClassBothOK,
		ID:     "both-ok",
		// Contract must be deterministic: the hidden test calls calc.mul(4,7).
		// Vague intents ("add a multiply function") let correct agents pick
		// another name (multiply) and fail the hidden test — measured 6/6
		// false-green. The intent pins the exact symbol the eval checks.
		Intent: "add a `mul(a, b)` function to the calc module that returns a * b",
		Policy: `version: 1
checks:
  unit:
    run: [./test/run.sh]
    test_format: junit
policies:
  - match: ["src/**"]
    require: [unit]
`,
		Base: []File{
			{Path: "src/__init__.py", Content: srcInit},
			{Path: "src/calc.py", Content: "def add(a, b):\n    return a + b\n"},
			{Path: "tests/__init__.py", Content: initPy},
			{Path: "tests/test_calc.py", Content: "import unittest\nfrom src import calc\n\nclass TestCalc(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(calc.add(2, 3), 5)\n"},
			{Path: "test/run.sh", Content: pyRunner},
		},
		Proposed: []File{
			{Path: "src/calc.py", Content: "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n"},
		},
		Gold: []File{
			{Path: "src/calc.py", Content: "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n"},
		},
		HiddenTests: []File{
			{Path: "tests/test_mul.py", Content: "import unittest\nfrom src import calc\n\nclass TestMul(unittest.TestCase):\n    def test_mul(self):\n        self.assertEqual(calc.mul(4, 7), 28)\n"},
		},
		GoldObligations: []string{"unit"},
	}
}

func bothFailFixture() *Task {
	// The coverage obligation can never be satisfied: the provider reports
	// only line 2, and the change adds line 1 (MODE). No fix can pass.
	return &Task{
		Class:  ClassBothFail,
		ID:     "both-fail",
		Intent: "add a MODE constant to the service module",
		Policy: `version: 1
checks:
  cov:
    run: [./cov.sh]
    coverage_format: lcov
policies:
  - match: ["src/**"]
    require: [coverage:lcov]
`,
		Base: []File{
			{Path: "src/__init__.py", Content: srcInit},
			{Path: "src/svc.py", Content: "def status():\n    return \"ok\"\n"},
			{Path: "tests/__init__.py", Content: initPy},
			{Path: "tests/test_svc.py", Content: "import unittest\nfrom src import svc\n\nclass TestSvc(unittest.TestCase):\n    def test_status(self):\n        self.assertEqual(svc.status(), \"ok\")\n"},
			{Path: "test/run.sh", Content: pyRunner},
			{Path: "cov.sh", Content: lcovPartial},
		},
		Proposed: []File{
			{Path: "src/svc.py", Content: "MODE = \"prod\"\n\ndef status():\n    return \"ok\"\n"},
		},
		Gold: nil, // nothing can satisfy the coverage obligation
		HiddenTests: []File{
			{Path: "tests/test_mode.py", Content: "import unittest\nfrom src import svc\n\nclass TestMode(unittest.TestCase):\n    def test_mode(self):\n        self.assertEqual(svc.MODE, \"prod\")\n"},
		},
		GoldObligations: []string{"coverage:lcov"},
	}
}

func canHurtFixture() *Task {
	// Ambiguous intent ("faster") plus three slow-but-passing checks: the
	// change is correct either way, so Proof adds measured overhead only.
	return &Task{
		Class:  ClassCanHurt,
		ID:     "can-hurt",
		Intent: "make the fast function even faster",
		Policy: `version: 1
checks:
  lint:
    run: [./sleepy.sh]
  typecheck:
    run: [./sleepy.sh]
  bench:
    run: [./sleepy.sh]
policies:
  - match: ["**"]
    require: [lint, typecheck, bench]
`,
		Base: []File{
			{Path: "src/__init__.py", Content: srcInit},
			{Path: "src/perf.py", Content: "def fast(x):\n    return x * 2\n"},
			{Path: "tests/__init__.py", Content: initPy},
			{Path: "tests/test_perf.py", Content: "import unittest\nfrom src import perf\n\nclass TestPerf(unittest.TestCase):\n    def test_fast(self):\n        self.assertEqual(perf.fast(21), 42)\n"},
			{Path: "test/run.sh", Content: pyRunner},
			{Path: "sleepy.sh", Content: sleepyTool},
		},
		Proposed: []File{
			{Path: "src/perf.py", Content: "def fast(x):\n    return x << 1\n"},
		},
		Gold: []File{
			{Path: "src/perf.py", Content: "def fast(x):\n    return x << 1\n"},
		},
		HiddenTests: []File{
			{Path: "tests/test_fast2.py", Content: "import unittest\nfrom src import perf\n\nclass TestFast2(unittest.TestCase):\n    def test_fast2(self):\n        self.assertEqual(perf.fast(3), 6)\n"},
		},
		GoldObligations: []string{"lint", "typecheck", "bench"},
	}
}

// Fixtures is the task class table: the canonical fixture set.
var Fixtures = map[TaskClass]*Task{
	ClassHelps:    helpsFixture(),
	ClassBothOK:   bothOKFixture(),
	ClassBothFail: bothFailFixture(),
	ClassCanHurt:  canHurtFixture(),
}

// FixtureFor returns the fixture for a class.
func FixtureFor(c TaskClass) (*Task, error) {
	t, ok := Fixtures[c]
	if !ok {
		return nil, fmt.Errorf("unknown task class %q (want %v)", c, AllClasses)
	}
	return t, nil
}
