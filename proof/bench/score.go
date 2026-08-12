package bench

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
)

// Score is one measured (task, condition, iteration) outcome. Correctness,
// safety, and efficiency are reported separately, never collapsed into one
// flattering composite.
type Score struct {
	Class         TaskClass `json:"class"`
	TaskID        string    `json:"task_id"`
	Condition     string    `json:"condition"` // A or B
	Iteration     int       `json:"iteration"`
	HiddenPass    bool      `json:"hidden_pass"`
	Obligations   bool      `json:"obligations_satisfied"`
	Verified      bool      `json:"verified_change"`
	FalseGreen    bool      `json:"false_green"`
	HonestOpen    bool      `json:"honest_unresolved"`
	OblRecall     float64   `json:"obligation_recall"`
	OblPrecision  float64   `json:"obligation_precision"`
	WallMS        int64     `json:"wall_ms"`
	Commands      int       `json:"commands"`
	EvidenceReuse bool      `json:"evidence_reuse"`
	PacketPath    string    `json:"packet_path,omitempty"`
}

// Scorer evaluates one agent result against a task.
type Scorer struct {
	ProofBin string
}

// ScoreResult runs hidden tests, verifies obligations, and computes metrics
// for one agent run.
func (s *Scorer) ScoreResult(ctx context.Context, task *Task, res *AgentResult, iteration int) Score {
	sc := Score{
		Class: task.Class, TaskID: task.ID, Condition: res.Condition,
		Iteration: iteration, WallMS: res.WallMS, Commands: res.Commands,
		PacketPath: res.PacketPath,
	}
	if res.Err != nil {
		return sc
	}
	// Hidden tests are applied only at scoring time. Commit the agent's
	// working tree first so proof's Git comparison sees the change the agent
	// actually produced (some agents edit without committing).
	commitIfDirty(res.WorkDir)
	if err := ApplyHidden(res.WorkDir, task.HiddenTests); err != nil {
		sc.HiddenPass = false
		return sc
	}
	sc.HiddenPass = runHiddenTests(res.WorkDir)

	// Obligations are determined post-hoc on the committed final state for
	// both conditions; the agent's own packet may be stale or empty.
	status := s.postHocStatus(ctx, task, res)
	sc.Obligations = status == "satisfied"
	if res.PacketPath == "" {
		res.PacketPath = latestPacket(res.WorkDir)
	}

	sc.Verified = sc.HiddenPass && sc.Obligations
	sc.FalseGreen = res.ClaimedDone && !sc.Verified
	// "Honest unresolved": only condition B can be honest about it — the
	// agent declined to claim success while Proof reported unsupported
	// obligations.
	sc.HonestOpen = res.Condition == "B" && !res.ClaimedDone && !sc.Verified
	sc.OblRecall, sc.OblPrecision = obligationStats(res.PacketPath, task.GoldObligations)
	if res.Condition == "B" && res.BaseSHA != "" {
		sc.EvidenceReuse = s.detectReuse(ctx, task, res)
	}
	return sc
}

// postHocStatus runs proof verify on condition A's final tree.
func (s *Scorer) postHocStatus(ctx context.Context, task *Task, res *AgentResult) string {
	proof := []string{"proof"}
	if s.ProofBin != "" {
		proof = []string{s.ProofBin}
	}
	cmd := exec.CommandContext(ctx, proof[0], append(proof[1:], "verify",
		"--base", res.BaseSHA, "--intent", task.Intent)...)
	cmd.Dir = res.WorkDir
	out, _ := cmd.CombinedOutput()
	status := statusFromOut(out)
	if status == "" {
		status = "error"
	}
	return status
}

// runHiddenTests executes the repo's test suite with hidden tests applied.
func runHiddenTests(dir string) bool {
	cmd := exec.Command("python3", "-m", "unittest", "discover", "-s", "tests", "-q")
	cmd.Dir = dir
	return cmd.Run() == nil
}

// latestPacket finds the most recent packet a run produced.
func latestPacket(workDir string) string {
	runs := filepath.Join(workDir, ".proof", "runs")
	entries, err := os.ReadDir(runs)
	if err != nil {
		return ""
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	return filepath.Join(runs, names[len(names)-1], "packet.json")
}

// statusAt reads a packet JSON and returns its CI status. An absent or empty
// obligation list is unresolved, never satisfied.
func statusAt(packetPath string) string {
	data, err := os.ReadFile(packetPath)
	if err != nil {
		return ""
	}
	var p struct {
		Obligations []struct {
			Status   string `json:"status"`
			Required bool   `json:"required"`
		} `json:"obligations"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return ""
	}
	violated, unresolved := false, false
	for _, o := range p.Obligations {
		if o.Status == "violated" {
			violated = true
		}
		if o.Status == "unresolved" && o.Required {
			unresolved = true
		}
	}
	if violated {
		return "violated"
	}
	if unresolved || len(p.Obligations) == 0 {
		return "unresolved"
	}
	return "satisfied"
}

// commitIfDirty commits the working tree if the agent left uncommitted edits.
func commitIfDirty(dir string) {
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "agent final state"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Run() // commit may legitimately report "nothing to commit"
	}
}

// obligationStats computes recall/precision of satisfied obligations against
// gold labels. The packet path may be empty for condition A; then it counts
// nothing (0/0 -> 1.0 precision, 0 recall).
func obligationStats(packetPath string, gold []string) (recall, precision float64) {
	if packetPath == "" {
		if len(gold) == 0 {
			return 1, 1
		}
		return 0, 1
	}
	data, err := os.ReadFile(packetPath)
	if err != nil {
		return 0, 1
	}
	var p struct {
		Obligations []struct {
			ID         string         `json:"id"`
			Status     string         `json:"status"`
			PolicyRule map[string]any `json:"policy_rule,omitempty"`
		} `json:"obligations"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return 0, 1
	}
	goldSet := map[string]bool{}
	for _, g := range gold {
		goldSet[g] = true
	}
	satisfied := 0
	satisfiedGold := 0
	for _, o := range p.Obligations {
		label := o.ID
		if req, ok := o.PolicyRule["require"].(string); ok && req != "" {
			label = req
		}
		if o.Status == "satisfied" || o.Status == "disposed" {
			satisfied++
			if goldSet[label] {
				satisfiedGold++
			}
		}
	}
	if len(gold) > 0 {
		recall = float64(satisfiedGold) / float64(len(gold))
	}
	if satisfied > 0 {
		precision = float64(satisfiedGold) / float64(satisfied)
	} else if len(gold) == 0 {
		precision = 1
	}
	return recall, precision
}

// detectReuse re-runs verify on a finished B tree and checks for evidence
// reuse markers.
func (s *Scorer) detectReuse(ctx context.Context, task *Task, res *AgentResult) bool {
	proof := []string{"proof"}
	if s.ProofBin != "" {
		proof = []string{s.ProofBin}
	}
	cmd := exec.CommandContext(ctx, proof[0], append(proof[1:], "verify",
		"--base", res.BaseSHA, "--intent", task.Intent)...)
	cmd.Dir = res.WorkDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	_ = out
	runs := filepath.Join(res.WorkDir, ".proof", "runs")
	entries, _ := os.ReadDir(runs)
	if len(entries) == 0 {
		return false
	}
	last := entries[len(entries)-1].Name()
	data, err := os.ReadFile(filepath.Join(runs, last, "packet.json"))
	if err != nil {
		return false
	}
	var p struct {
		Evidence []struct {
			Data map[string]any `json:"data"`
		} `json:"evidence"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return false
	}
	for _, e := range p.Evidence {
		if _, ok := e.Data["reuse"]; ok {
			return true
		}
	}
	return false
}

// SortScores orders scores deterministically.
func SortScores(scores []Score) {
	sort.Slice(scores, func(i, j int) bool {
		a, b := scores[i], scores[j]
		if a.Class != b.Class {
			return ClassOrder[a.Class] < ClassOrder[b.Class]
		}
		if a.Condition != b.Condition {
			return a.Condition < b.Condition
		}
		return a.Iteration < b.Iteration
	})
}
