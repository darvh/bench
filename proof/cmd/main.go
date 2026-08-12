// Command proofbench runs the ProofBench paired A/B benchmark.
//
//	proofbench tasks
//	proofbench run --class <class|all> --driver scripted|cli:<template>
//	    [--iterations N] [--condition A|B] [--proof-bin PATH] [--out DIR]
//	proofbench report --out DIR
//
// Each fixture runs in a fresh context under condition A (no Proof) and B
// (with Proof). The scripted driver is a deterministic stand-in for
// conformance; the cli driver runs a real coding agent (any vendor) for the
// externally credible evaluation.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/darvh/proof/bench"
)

const usage = `proofbench: ProofBench paired A/B benchmark

  proofbench tasks                                    list task classes
  proofbench run --class <class|all> --driver D [opts]
      --driver scripted | cli:<shell template with {intent}>
      --iterations N (default 3)
      --condition A|B (default both)
      --proof-bin PATH (path to the proof binary under test)
      --out DIR (default ./.proofbench)
  proofbench report --out DIR

measures (per condition, separately):
  verified_change_rate, false_green_rate, hidden_test_pass_rate,
  honest_unresolved_rate, obligation recall/precision, wall time,
  command count, proof overhead, evidence reuse (warm runs)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "tasks":
		for _, c := range bench.AllClasses {
			t, _ := bench.FixtureFor(c)
			fmt.Printf("%-12s %s\n", c, t.Intent)
		}
	case "run":
		os.Exit(runCmd(os.Args[2:]))
	case "calibrate":
		os.Exit(calibrateCmd(os.Args[2:]))
	case "report":
		os.Exit(reportCmd(os.Args[2:]))
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

// calibrateCmd sweeps the per-run time budget for one class and reports A vs B
// discrimination at each budget. The helps class only discriminates where a
// strong model at high thinking misses the hidden failure without proof
// (measured: verified at 300s-cutoff, missed... at 600s it is caught). Pick the
// budget where A-miss is >0 but B-miss is ~0, then freeze it in the fixture.
func calibrateCmd(args []string) int {
	fs := flag.NewFlagSet("calibrate", flag.ContinueOnError)
	class := fs.String("class", "helps", "task class to calibrate")
	driver := fs.String("driver", "scripted", "scripted | cli:<template>")
	proofBin := fs.String("proof-bin", "", "path to proof binary")
	budgets := fs.String("budgets", "120,180,240,300,450,600", "comma-separated per-run budgets in seconds")
	thinking := fs.String("thinking", "high", "reasoning effort: default | low | medium | high")
	out := fs.String("out", ".proofbench", "output directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	t, err := bench.FixtureFor(bench.TaskClass(*class))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	scorer := &bench.Scorer{ProofBin: *proofBin}
	ctx := context.Background()

	fmt.Printf("calibrating %s (driver=%s) budget sweep\n", *class, *driver)
	fmt.Printf("%-8s %-6s %-10s %-10s %-10s %-10s %-8s\n", "budget", "cond", "verified", "false-gr", "hidden", "honest", "wall_med")
	for _, b := range strings.Split(*budgets, ",") {
		secs, err := strconv.Atoi(strings.TrimSpace(b))
		if err != nil {
			continue
		}
		for _, cond := range []string{"A", "B"} {
			dir := filepath.Join(*out, "cal", *class, fmt.Sprintf("b%d", secs), cond)
			os.RemoveAll(dir)
			root, base, err := t.NewRepo(dir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "%v\n", err)
				return 2
			}
			res := runOne(ctx, t, scorer, root, base, cond == "B", *driver, *proofBin, *thinking, secs, filepath.Join(dir, "raw"))
			aggs := bench.Aggregate([]bench.Score{scorer.ScoreResult(ctx, t, res, 1)})
			row := aggs[0]
			fmt.Printf("%-8d %-6s %-10.2f %-10.2f %-10.2f %-10.2f %-8d\n",
				secs, cond, row.VerifiedRate, row.FalseGreenRate, row.HiddenPassRate, row.HonestOpenRate, res.WallMS)
		}
	}
	return 0
}

func runOne(ctx context.Context, task *bench.Task, scorer *bench.Scorer, root, base string, proofOn bool, driver, proofBin, thinking string, timeoutSec int, rawDir string) *bench.AgentResult {
	var drv bench.Driver
	switch {
	case driver == "scripted":
		drv = bench.ScriptedDriver{}
	case strings.HasPrefix(driver, "cli:"):
		drv = bench.CLI{Template: strings.TrimPrefix(driver, "cli:"), Variant: thinking}
	default:
		drv = bench.ScriptedDriver{}
	}
	return drv.Run(ctx, task, bench.RunOptions{
		WorkDir: root, BaseSHA: base, ProofBin: proofBin,
		ProofOn: proofOn,
		Timeout: time.Duration(timeoutSec) * time.Second,
		RawDir:  rawDir,
		CleanEnv: true,
	})
}

func runCmd(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	class := fs.String("class", "all", "task class or all")
	driver := fs.String("driver", "scripted", "scripted | cli:<template>")
	iterations := fs.Int("iterations", 3, "iterations per condition")
	condition := fs.String("condition", "both", "A | B | both")
	proofBin := fs.String("proof-bin", "", "path to proof binary")
	timeout := fs.Int("timeout", 600, "per-run time budget in seconds (cli driver)")
	out := fs.String("out", ".proofbench", "output directory")
	thinking := fs.String("thinking", "high", "reasoning effort: default | low | medium | high (injected as {variant} in a cli template)")
	clean := fs.Bool("clean", true, "isolate the agent: no host plugins/MCP/skills (proof-only measurement)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	classes := []bench.TaskClass{bench.ClassHelps, bench.ClassBothOK, bench.ClassBothFail, bench.ClassCanHurt}
	if *class != "all" {
		t, err := bench.FixtureFor(bench.TaskClass(*class))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		classes = []bench.TaskClass{t.Class}
	}
	var drv bench.Driver
	template := ""
	switch {
	case *driver == "scripted":
		drv = bench.ScriptedDriver{}
	case strings.HasPrefix(*driver, "cli:"):
		template = strings.TrimPrefix(*driver, "cli:")
		drv = bench.CLI{Template: template, Variant: *thinking}
	default:
		fmt.Fprintf(os.Stderr, "unknown driver %q\n", *driver)
		return 2
	}

	ctx := context.Background()
	scorer := &bench.Scorer{ProofBin: *proofBin}
	var scores []bench.Score
	workBase := filepath.Join(*out, "work")
	os.RemoveAll(workBase)
	os.MkdirAll(workBase, 0o755)

	for _, c := range classes {
		task, err := bench.FixtureFor(c)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		for it := 1; it <= *iterations; it++ {
			for _, cond := range []string{"A", "B"} {
				if *condition != "both" && *condition != cond {
					continue
				}
				dir := filepath.Join(workBase, task.ID, fmt.Sprintf("iter-%d", it))
				os.RemoveAll(dir)
				root, base, err := task.NewRepo(dir)
				if err != nil {
					fmt.Fprintf(os.Stderr, "%s: %v\n", task.ID, err)
					return 2
				}
				rawDir := filepath.Join(*out, "raw", task.ID, cond, fmt.Sprintf("iter-%d", it))
				res := drv.Run(ctx, task, bench.RunOptions{
					WorkDir: root, BaseSHA: base, ProofBin: *proofBin,
					ProofOn: cond == "B",
					Timeout: time.Duration(*timeout) * time.Second,
					RawDir:  rawDir,
					CleanEnv: *clean,
				})
			sc := scorer.ScoreResult(ctx, task, res, it)
			if len(res.ForeignTools) > 0 {
				fmt.Fprintf(os.Stderr, "  WARN %s/%s iter-%d: foreign tools invoked: %s (proof-only measurement compromised)\n",
					task.ID, cond, it, strings.Join(res.ForeignTools, ", "))
			}
			scores = append(scores, sc)
				saveRaw(*out, task, res, sc)
			}
			fmt.Printf("  %s iteration %d done\n", task.ID, it)
		}
	}
	bench.SortScores(scores)
	rows := bench.Aggregate(scores)
	rep := &bench.Report{
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
		Driver:     drv.Name(),
		Model:      cliModel(template),
		Thinking:   *thinking,
		TimeoutSec: *timeout,
		Rows:       rows,
		Scores:     scores,
	}
	if err := bench.WriteReport(*out, rep); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	fmt.Println("\n" + renderTable(rep))
	return 0
}

func reportCmd(args []string) int {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	out := fs.String("out", ".proofbench", "output directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	data, err := os.ReadFile(filepath.Join(*out, "report.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	var rep bench.Report
	if err := json.Unmarshal(data, &rep); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	fmt.Print(renderTable(&rep))
	return 0
}

func renderTable(rep *bench.Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "ProofBench (%s)\n", rep.Driver)
	fmt.Fprintf(&b, "%-12s %-2s %3s  %-8s %-9s %-9s %-8s %-6s %-6s %8s %8s %4s %8s\n",
		"class", "c", "n", "verified", "false-gr", "hidden", "honest", "recall", "prec", "wall_med", "p95", "cmds", "overhead")
	for _, a := range rep.Rows {
		fmt.Fprintf(&b, "%-12s %-2s %3d  %-8.2f %-9.2f %-9.2f %-8.2f %-6.2f %-6.2f %8d %8d %4d %8d\n",
			a.Class, a.Condition, a.Samples, a.VerifiedRate, a.FalseGreenRate,
			a.HiddenPassRate, a.HonestOpenRate, a.ObligationRecall, a.ObligationPrecision,
			a.WallMedianMS, a.WallP95MS, a.CommandsMedian, a.ProofOverheadMS)
	}
	return b.String()
}

// cliModel extracts the model from a cli driver template's `-m <model>`, if any.
func cliModel(template string) string {
	if template == "" {
		return ""
	}
	m := regexp.MustCompile(`-m\s+(\S+)`).FindStringSubmatch(template)
	if m == nil {
		return ""
	}
	return m[1]
}

// saveRaw stores transcripts, diffs, and packets for auditability.
func saveRaw(out string, task *bench.Task, res *bench.AgentResult, sc bench.Score) {
	dir := filepath.Join(out, "raw", task.ID, res.Condition, fmt.Sprintf("iter-%d", sc.Iteration))
	os.MkdirAll(dir, 0o755)
	if len(res.Transcript) > 0 {
		os.WriteFile(filepath.Join(dir, "agent.txt"), res.Transcript, 0o644)
	}
	if res.PacketPath != "" {
		if data, err := os.ReadFile(res.PacketPath); err == nil {
			os.WriteFile(filepath.Join(dir, "packet.json"), data, 0o644)
		}
	}
	if diff := gitDiff(res.WorkDir); diff != "" {
		os.WriteFile(filepath.Join(dir, "change.diff"), []byte(diff), 0o644)
	}
	os.WriteFile(filepath.Join(dir, "score.json"), mustJSON(sc), 0o644)
}

func gitDiff(dir string) string {
	cmd := exec.Command("git", "diff", "HEAD~1", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func mustJSON(v any) []byte {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return []byte("{}")
	}
	return b
}
