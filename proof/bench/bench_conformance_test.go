package tests

// ProofBench conformance: the controlled fixtures prove the benchmark harness
// discriminates the four task classes under the deterministic scripted
// driver. This is the conformance suite, not the headline public benchmark
// (which uses a real coding agent via the cli driver).

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/darvh/proof/bench"
)

// benchProof builds the proof binary once per test.
func benchProof(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "proof")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/proof")
	cmd.Dir = ".."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build proof: %v\n%s", err, out)
	}
	return bin
}

func runBenchClass(t *testing.T, class bench.TaskClass, proofBin string) map[string]bool {
	t.Helper()
	task, err := bench.FixtureFor(class)
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	scorer := &bench.Scorer{ProofBin: proofBin}
	ctx := context.Background()
	out := map[string]bool{}
	for _, cond := range []string{"A", "B"} {
		root, base, err := task.NewRepo(filepath.Join(work, cond))
		if err != nil {
			t.Fatal(err)
		}
		res := bench.ScriptedDriver{}.Run(ctx, task, bench.RunOptions{
			WorkDir: root, BaseSHA: base, ProofBin: proofBin, ProofOn: cond == "B",
		})
		sc := scorer.ScoreResult(ctx, task, res, 1)
		out["verified:"+cond] = sc.Verified
		out["falseGreen:"+cond] = sc.FalseGreen
		out["honest:"+cond] = sc.HonestOpen
		out["hidden:"+cond] = sc.HiddenPass
	}
	return out
}

// The signature fixture: A appears complete (hidden fails), B is verified.
func TestBenchHelpsClass(t *testing.T) {
	proofBin := benchProof(t)
	got := runBenchClass(t, bench.ClassHelps, proofBin)
	if got["verified:A"] || !got["falseGreen:A"] {
		t.Errorf("helps A: want false-green without verification, got %v", got)
	}
	if !got["verified:B"] || got["falseGreen:B"] || !got["hidden:B"] {
		t.Errorf("helps B: want verified change, got %v", got)
	}
}

func TestBenchBothSucceedClass(t *testing.T) {
	proofBin := benchProof(t)
	got := runBenchClass(t, bench.ClassBothOK, proofBin)
	if !got["verified:A"] || !got["verified:B"] {
		t.Errorf("both-succeed: want verified under both conditions, got %v", got)
	}
	if got["falseGreen:A"] || got["falseGreen:B"] {
		t.Errorf("both-succeed: no false green expected, got %v", got)
	}
}

func TestBenchBothFailClass(t *testing.T) {
	proofBin := benchProof(t)
	got := runBenchClass(t, bench.ClassBothFail, proofBin)
	if !got["falseGreen:A"] {
		t.Errorf("both-fail A: want false-green claim, got %v", got)
	}
	if !got["honest:B"] || got["falseGreen:B"] || got["verified:B"] {
		t.Errorf("both-fail B: want honest unresolved (no false success), got %v", got)
	}
}

func TestBenchCanHurtClass(t *testing.T) {
	proofBin := benchProof(t)
	got := runBenchClass(t, bench.ClassCanHurt, proofBin)
	if !got["verified:A"] || !got["verified:B"] {
		t.Errorf("can-hurt: change correct under both conditions, got %v", got)
	}
	_ = os.Getenv
}
