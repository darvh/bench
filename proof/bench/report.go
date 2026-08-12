package bench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Agg is one aggregated (class, condition) row. Correctness, safety, and
// efficiency stay separate.
type Agg struct {
	Class               TaskClass `json:"class"`
	Condition           string    `json:"condition"`
	Samples             int       `json:"samples"`
	VerifiedRate        float64   `json:"verified_change_rate"`
	FalseGreenRate      float64   `json:"false_green_rate"`
	HiddenPassRate      float64   `json:"hidden_test_pass_rate"`
	HonestOpenRate      float64   `json:"honest_unresolved_rate"`
	ObligationRecall    float64   `json:"obligation_recall"`
	ObligationPrecision float64   `json:"obligation_precision"`
	WallMedianMS        int64     `json:"wall_median_ms"`
	WallP95MS           int64     `json:"wall_p95_ms"`
	CommandsMedian      int       `json:"commands_median"`
	EvidenceReuseRate   float64   `json:"evidence_reuse_rate,omitempty"`
	ProofOverheadMS     int64     `json:"proof_overhead_ms,omitempty"`
}

// Aggregate folds scores into rows and computes the paired A/B overhead.
func Aggregate(scores []Score) []Agg {
	byKey := map[string][]Score{}
	for _, s := range scores {
		key := string(s.Class) + "|" + s.Condition
		byKey[key] = append(byKey[key], s)
	}
	var rows []Agg
	for _, c := range AllClasses {
		for _, cond := range []string{"A", "B"} {
			ss := byKey[string(c)+"|"+cond]
			if len(ss) == 0 {
				continue
			}
			rows = append(rows, aggRow(c, cond, ss))
		}
	}
	// Paired overhead: B - A per (class, iteration), median per class.
	for _, c := range AllClasses {
		var deltas []int64
		a := byKey[string(c)+"|A"]
		b := byKey[string(c)+"|B"]
		bByIter := map[int]int64{}
		for _, s := range b {
			bByIter[s.Iteration] = s.WallMS
		}
		for _, s := range a {
			if bw, ok := bByIter[s.Iteration]; ok {
				deltas = append(deltas, bw-s.WallMS)
			}
		}
		if len(deltas) > 0 {
			for i := range rows {
				if rows[i].Class == c && rows[i].Condition == "B" {
					rows[i].ProofOverheadMS = medianI64(deltas)
				}
			}
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Class != rows[j].Class {
			return ClassOrder[rows[i].Class] < ClassOrder[rows[j].Class]
		}
		return rows[i].Condition < rows[j].Condition
	})
	return rows
}

func aggRow(class TaskClass, cond string, ss []Score) Agg {
	var verified, falseGreen, hidden, honest int
	var recall, precision float64
	var wall []int64
	var cmds []int
	reuse := 0
	for _, s := range ss {
		if s.Verified {
			verified++
		}
		if s.FalseGreen {
			falseGreen++
		}
		if s.HiddenPass {
			hidden++
		}
		if s.HonestOpen {
			honest++
		}
		recall += s.OblRecall
		precision += s.OblPrecision
		wall = append(wall, s.WallMS)
		cmds = append(cmds, s.Commands)
		if s.EvidenceReuse {
			reuse++
		}
	}
	n := len(ss)
	return Agg{
		Class: class, Condition: cond, Samples: n,
		VerifiedRate:        rate(verified, n),
		FalseGreenRate:      rate(falseGreen, n),
		HiddenPassRate:      rate(hidden, n),
		HonestOpenRate:      rate(honest, n),
		ObligationRecall:    recall / float64(n),
		ObligationPrecision: precision / float64(n),
		WallMedianMS:        medianI64(wall),
		WallP95MS:           p95I64(wall),
		CommandsMedian:      medianInt(cmds),
		EvidenceReuseRate:   rate(reuse, n),
	}
}

func rate(v, n int) float64 {
	if n == 0 {
		return 0
	}
	return float64(v) / float64(n)
}

func medianI64(v []int64) int64 {
	if len(v) == 0 {
		return 0
	}
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	return v[len(v)/2]
}

func medianInt(v []int) int {
	if len(v) == 0 {
		return 0
	}
	sort.Ints(v)
	return v[len(v)/2]
}

func p95I64(v []int64) int64 {
	if len(v) == 0 {
		return 0
	}
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	idx := (len(v)*95 + 99) / 100
	if idx >= len(v) {
		idx = len(v) - 1
	}
	return v[idx]
}

// Report is the full benchmark output.
type Report struct {
	Timestamp  string  `json:"timestamp"`
	Driver     string  `json:"driver"`
	Model      string  `json:"model,omitempty"`
	Thinking   string  `json:"thinking,omitempty"`
	TimeoutSec int     `json:"timeout_sec,omitempty"`
	Rows       []Agg   `json:"rows"`
	Scores     []Score `json:"scores"`
}

// WriteReport persists scores and the aggregated report as JSON + a compact
// Markdown table.
func WriteReport(dir string, r *Report) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "report.json"), data, 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "report.md"), []byte(renderMarkdown(r)), 0o644)
}

func renderMarkdown(r *Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# ProofBench report\n\ndriver: %s | model: %s | thinking: %s | timeout: %ds\n\n",
		r.Driver, r.Model, r.Thinking, r.TimeoutSec)
	b.WriteString("| class | cond | n | verified | false-green | hidden pass | honest open | recall | precision | wall med | wall p95 | cmds | overhead |\n")
	b.WriteString("|-------|------|---|----------|-------------|-------------|-------------|--------|-----------|----------|----------|------|----------|\n")
	for _, a := range r.Rows {
		fmt.Fprintf(&b, "| %s | %s | %d | %.2f | %.2f | %.2f | %.2f | %.2f | %.2f | %d | %d | %d | %d |\n",
			a.Class, a.Condition, a.Samples, a.VerifiedRate, a.FalseGreenRate,
			a.HiddenPassRate, a.HonestOpenRate, a.ObligationRecall, a.ObligationPrecision,
			a.WallMedianMS, a.WallP95MS, a.CommandsMedian, a.ProofOverheadMS)
	}
	return b.String()
}
