package bench

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// RunOptions configures one agent condition run.
type RunOptions struct {
	WorkDir  string // fresh task repo rooted at base
	BaseSHA  string
	ProofBin string // path to the proof binary under test
	ProofOn  bool
	Timeout  time.Duration // per-run time budget (0 = default)
	Warm     bool          // warm run: re-verify in place to measure evidence reuse
	RawDir   string        // where the run's raw artifacts (session.jsonl etc.) are stored
	CleanEnv bool          // isolate the agent: no host plugins/MCP/skills, --pure
	Env      map[string]string
}

// AgentResult is the outcome of one condition run.
type AgentResult struct {
	Condition    string // "A" (no proof) or "B" (with proof)
	ClaimedDone  bool
	WorkDir      string
	BaseSHA      string
	DiffSHA      string
	WallMS       int64
	Commands     int
	PacketPath   string
	Transcript   []byte
	ForeignTools []string // non-core tools the agent invoked (skills, MCP, plugins)
	Err          error
}

// Driver runs a coding agent under a condition.
type Driver interface {
	Name() string
	// Run executes the agent once in a fresh copy at base, mutating WorkDir,
	// and returns the result. The scorer evaluates the resulting tree.
	Run(ctx context.Context, task *Task, opts RunOptions) *AgentResult
}

// ScriptedDriver is a deterministic stand-in agent for conformance and for
// exercising the harness. It is NOT the benchmark's headline result: the
// external A/B evaluation uses the CLI driver pointed at a real coding agent.
//
// Without Proof it applies the seeded proposed change and claims success —
// the "apparently successful change". With Proof it runs the packet and, when
// a required obligation is unsupported, applies the red test then the gold
// fix, verifying each step — the "evidence-backed change".
type ScriptedDriver struct{}

func (ScriptedDriver) Name() string { return "scripted" }

func (d ScriptedDriver) Run(ctx context.Context, task *Task, opts RunOptions) *AgentResult {
	res := &AgentResult{Condition: cond(opts.ProofOn), WorkDir: opts.WorkDir, BaseSHA: opts.BaseSHA}
	start := time.Now()
	defer func() { res.WallMS = time.Since(start).Milliseconds() }()
	proof := proofCmd(opts)

	if !opts.ProofOn {
		if _, err := Apply(opts.WorkDir, task.Proposed); err != nil {
			res.Err = err
			return res
		}
		res.Commands++
		res.ClaimedDone = true
		return res
	}

	// With Proof: apply the change, then follow the TDD loop — write the
	// behavior's targeted test (red), fix it (green), verifying each step.
	// Escalate only while a required obligation is unsupported.
	if _, err := Apply(opts.WorkDir, task.Proposed); err != nil {
		res.Err = err
		return res
	}
	res.Commands++
	if len(task.HiddenTests) > 0 {
		// The TDD agent's targeted test: fails on the current (unfixed) code.
		if _, err := Apply(opts.WorkDir, task.HiddenTests); err != nil {
			res.Err = err
			return res
		}
		res.Commands++
	}
	status, _, err := runProof(ctx, proof, task, opts, res)
	if err != nil {
		res.Err = err
		return res
	}
	if status != "satisfied" && len(task.Gold) > 0 {
		if _, err := Apply(opts.WorkDir, task.Gold); err != nil {
			res.Err = err
			return res
		}
		res.Commands++
		status, _, err = runProof(ctx, proof, task, opts, res)
		if err != nil {
			res.Err = err
			return res
		}
	}
	res.ClaimedDone = status == "satisfied"
	return res
}

func proofCmd(opts RunOptions) []string {
	if opts.ProofBin != "" {
		return []string{opts.ProofBin}
	}
	return []string{"proof"}
}

// runProof runs `proof verify` in the work dir. Returns the CI status and the
// packet path (best effort).
func runProof(ctx context.Context, proof []string, task *Task, opts RunOptions, res *AgentResult) (string, string, error) {
	cmd := exec.CommandContext(ctx, proof[0], append(proof[1:], "verify",
		"--base", opts.BaseSHA, "--intent", task.Intent)...)
	cmd.Dir = opts.WorkDir
	cmd.Env = append(os.Environ(), "PROOF_BENCH=1")
	out, err := cmd.CombinedOutput()
	res.Transcript = append(res.Transcript, out...)
	res.Commands++
	status := statusFromOut(out)
	if status == "" {
		if err == nil {
			status = "satisfied"
		} else {
			status = "error"
		}
	}
	// Non-zero exits are valid CI verdicts (1 violated, 2 unresolved) and
	// must not abort the TDD loop; only an infra failure (exit 3, no status
	// line) is fatal.
	if err != nil && status == "error" {
		return status, "", fmt.Errorf("proof verify: %v\n%s", err, out)
	}
	var path string
	runs := filepath.Join(opts.WorkDir, ".proof", "runs")
	if entries, _ := os.ReadDir(runs); len(entries) > 0 {
		last := entries[len(entries)-1].Name()
		path = filepath.Join(runs, last, "packet.json")
		res.PacketPath = path
	}
	return status, path, nil
}

// statusFromOut extracts the CI status from `proof verify` stdout.
func statusFromOut(out []byte) string {
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "status:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "status:"))
		}
	}
	return ""
}

func cond(on bool) string {
	if on {
		return "B"
	}
	return "A"
}

// CLI driver executes an external coding agent for the real A/B benchmark.
// The command is a shell template ({intent}); the harness passes intent,
// proof flag, proof binary, and base through env vars. Vendor-neutral: any
// agent CLI (opencode run, codex exec, claude -p, ...) can be used.
type CLI struct {
	Template string
	Variant  string // reasoning effort level, rendered as `--variant <level> ` in a cli template
}

func (c CLI) Name() string { return "cli" }

func (c CLI) Run(ctx context.Context, task *Task, opts RunOptions) *AgentResult {
	res := &AgentResult{Condition: cond(opts.ProofOn), WorkDir: opts.WorkDir, BaseSHA: opts.BaseSHA}
	start := time.Now()
	defer func() { res.WallMS = time.Since(start).Milliseconds() }()
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmdline := strings.ReplaceAll(c.Template, "{intent}", task.Intent)
	variant := ""
	if c.Variant != "" && c.Variant != "default" {
		variant = "--variant " + c.Variant + " "
	}
	cmdline = strings.ReplaceAll(cmdline, "{variant}", variant)
	if opts.ProofOn {
		cmdline = strings.ReplaceAll(cmdline, "{proof}",
			"Follow Proof: after changing code run `proof verify --base <base> --intent \"<task>\"` (the proof binary is on PATH), read the packet, and satisfy every REQUIRED obligation: write the targeted test, see it fail (red), fix the code, keep it green. Never claim completion while a required obligation is violated or unresolved.")
	} else {
		cmdline = strings.ReplaceAll(cmdline, "{proof}", "")
	}
	cmd := exec.CommandContext(runCtx, "sh", "-c", cmdline)
	cmd.Dir = opts.WorkDir
	env := append(os.Environ(),
		"BENCH_INTENT="+task.Intent,
		"BENCH_PROOF_ON="+fmt.Sprintf("%v", opts.ProofOn),
		"BENCH_PROOF_BIN="+opts.ProofBin,
		"BENCH_BASE="+opts.BaseSHA,
	)
	if opts.CleanEnv {
		// Isolate the agent: a temp HOME/XDG config with ONLY the model auth —
		// no host plugins, MCP servers, or skills — and force `--pure`. The
		// bench must measure proof, not whatever the host's opencode loads.
		env = append(env, cleanAgentEnv()...)
		cmdline = strings.Replace(cmdline, "opencode run", "opencode run --pure ", 1)
		cmd = exec.CommandContext(runCtx, "sh", "-c", cmdline)
	}
	if opts.ProofBin != "" {
		binDir := filepath.Dir(opts.ProofBin)
		env = append(env, "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	res.Transcript = out
	res.ForeignTools = auditForeignTools(out)
	res.Commands = 1
	// The agent's own success claim is not trusted; the scorer re-checks. A
	// time-budget expiry is scored like any other outcome: the partial state
	// the agent left behind is what gets verified.
	res.ClaimedDone = true
	if err != nil && runCtx.Err() == nil {
		res.Err = err
	}
	exportSessionArtifacts(opts.RawDir, out)
	return res
}

// exportSessionArtifacts copies the host agent's full session record next to
// the bench transcript: the opencode message/part log (session.jsonl) and the
// tool-output blobs referenced by the run's call IDs. Best-effort and
// fail-open: a missing sqlite CLI or storage dir must never fail the bench.
func exportSessionArtifacts(rawDir string, out []byte) {
	if rawDir == "" {
		return
	}
	// Locate the session + call IDs from the opencode event stream.
	sid := ""
	callIDs := map[string]bool{}
	for _, m := range regexp.MustCompile(`"sessionID":"(ses_[^"]+)"`).FindAllSubmatch(out, -1) {
		sid = string(m[1])
		break
	}
	for _, m := range regexp.MustCompile(`"callID":"(call_[^"]+)"`).FindAllSubmatch(out, -1) {
		callIDs[string(m[1])] = true
	}
	if sid == "" {
		return // not an opencode run; nothing to export
	}
	os.MkdirAll(rawDir, 0o755)

	// 1) session.jsonl from the opencode database (message + part records).
	db := opencodeDB()
	if db != "" {
		if jl := dumpSession(db, sid); len(jl) > 0 {
			os.WriteFile(filepath.Join(rawDir, "session.jsonl"), jl, 0o644)
		}
	}

	// 2) tool-output blobs referenced by call IDs.
	if db != "" {
		td := filepath.Join(filepath.Dir(db), "tool-output")
		for id := range callIDs {
			src := filepath.Join(td, "tool_"+id)
			if st, err := os.Stat(src); err == nil && st.Mode().IsRegular() {
				if b, err := os.ReadFile(src); err == nil {
					os.WriteFile(filepath.Join(rawDir, "tool-"+id+".out"), b, 0o644)
				}
			}
		}
	}
}

func opencodeDB() string {
	if v := os.Getenv("OPENCODE_DB"); v != "" {
		return v
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".local", "share", "opencode", "opencode.db")
	}
	return ""
}

func dumpSession(db, sid string) []byte {
	// One JSON line per message and part, oldest first, tagged by kind.
	cmd := exec.Command("sqlite3", db,
		`SELECT json_object('kind','message','id',id,'time',time_created,'data',json(data)) FROM message WHERE session_id='`+sid+`' ORDER BY time_created;
		 SELECT json_object('kind','part','id',id,'message_id',message_id,'time',time_created,'data',json(data)) FROM part WHERE session_id='`+sid+`' ORDER BY time_created;`)
	b, err := cmd.CombinedOutput()
	if err != nil {
		return nil // sqlite3 not available or db locked
	}
	return b
}

// cleanAgentEnv returns env overrides that isolate the coding agent from the
// host's opencode configuration: a temp HOME/XDG with ONLY the model auth
// (opencode-go api key). No plugins, MCP servers, or skills load; the model
// still authenticates. Best-effort; on any failure the agent runs unisolated.
func cleanAgentEnv() []string {
	tmp, err := os.MkdirTemp("", "proof-bench-clean-")
	if err != nil {
		return nil
	}
	authSrc := filepath.Join(homeDir(), ".local", "share", "opencode", "auth.json")
	authDst := filepath.Join(tmp, ".local", "share", "opencode", "auth.json")
	if data, err := os.ReadFile(authSrc); err == nil {
		if os.MkdirAll(filepath.Dir(authDst), 0o755) == nil {
			_ = os.WriteFile(authDst, data, 0o600)
		}
	}
	return []string{
		"HOME=" + tmp,
		"XDG_CONFIG_HOME=" + filepath.Join(tmp, ".config"),
		"XDG_DATA_HOME=" + filepath.Join(tmp, ".local", "share"),
		"XDG_STATE_HOME=" + filepath.Join(tmp, ".local", "state"),
	}
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

// auditForeignTools scans the agent transcript for tool calls outside the
// core coding set. Anything else (skills, MCP servers, plugins like graft or
// context) is a confound for a proof-only measurement.
func auditForeignTools(out []byte) []string {
	core := map[string]bool{
		"bash": true, "read": true, "write": true, "edit": true, "glob": true,
		"grep": true, "list": true, "search": true, "patch": true, "mkdir": true,
		"touch": true, "ls": true, "cat": true, "mv": true, "cp": true, "rm": true,
		"todowrite": true, "todo": true, "plan": true, "ask": true, "agent": true,
	}
	seen := map[string]bool{}
	var foreign []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, `"tool_use"`) || !strings.Contains(line, `"tool":`) {
			continue
		}
		var ev struct {
			Part struct {
				Tool string `json:"tool"`
			} `json:"part"`
		}
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		t := ev.Part.Tool
		if t == "" || core[t] || seen[t] {
			continue
		}
		seen[t] = true
		foreign = append(foreign, t)
	}
	sort.Strings(foreign)
	return foreign
}
