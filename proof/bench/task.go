// Package bench implements ProofBench, the paired A/B benchmark for the
// central claim: with the same model, repository, task, tools, and budget,
// does Proof turn more apparently successful changes into actually correct,
// evidence-backed changes?
//
// Each task is a fixture repository with a task record (base revision,
// intent, optional seeded proposed change, policy, gold obligations, and
// hidden failures). Every fixture runs in a fresh context under two
// conditions: A (coding agent without Proof) and B (the same agent with
// Proof). The scorer measures correctness, safety, and efficiency
// separately and never collapses them into a single flattering score.
package bench

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// TaskClass identifies the four benchmark classes.
type TaskClass string

const (
	ClassHelps    TaskClass = "helps"        // Proof catches a defect native tests miss
	ClassBothOK   TaskClass = "both-succeed" // Proof preserves success with a useful receipt
	ClassBothFail TaskClass = "both-fail"    // Proof reports honest unresolved instead of confidence
	ClassCanHurt  TaskClass = "can-hurt"     // ambiguous intent / heavy policy exposes overhead
)

// AllClasses is the canonical task class list.
var AllClasses = []TaskClass{ClassHelps, ClassBothOK, ClassBothFail, ClassCanHurt}

// ClassOrder orders classes for deterministic output.
var ClassOrder = map[TaskClass]int{
	ClassHelps: 0, ClassBothOK: 1, ClassBothFail: 2, ClassCanHurt: 3,
}

// File is one generated repository file.
type File struct {
	Path    string
	Content string
}

// Task is the record for one benchmark fixture.
type Task struct {
	Class           TaskClass
	ID              string
	Intent          string
	Policy          string // .proof.yml content
	Base            []File // repository state at base (bug present)
	Proposed        []File // agent-style "complete-looking" change (native tests pass)
	Gold            []File // correct change
	HiddenTests     []File // applied only at scoring time, never during agent work
	GoldObligations []string
}

// NewRepo materializes a task fixture at a base commit and returns its root,
// base sha, and the "buggy base" working state.
func (t *Task) NewRepo(dir string) (root, baseSHA string, err error) {
	root = filepath.Join(dir, t.ID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	git(root, "init", "-q", "-b", "main")
	git(root, "config", "user.email", "bench@proof")
	git(root, "config", "user.name", "ProofBench")
	git(root, "config", "commit.gpgsign", "false")
	writeFiles(root, t.Base)
	if err := os.WriteFile(filepath.Join(root, ".proof.yml"), []byte(t.Policy), 0o644); err != nil {
		return "", "", err
	}
	git(root, "add", "-A")
	git(root, "commit", "-q", "-m", "base")
	baseSHA = strings.TrimSpace(gitOut(root, "rev-parse", "HEAD"))
	return root, baseSHA, nil
}

// Apply writes the given files on top of the base state (the agent's change
// or the scored gold patch) and commits.
func Apply(root string, files []File) (head string, err error) {
	writeFiles(root, files)
	git(root, "add", "-A")
	git(root, "commit", "-q", "-m", "change")
	return strings.TrimSpace(gitOut(root, "rev-parse", "HEAD")), nil
}

// ApplyHidden adds hidden tests to the repo WITHOUT committing (scoring only).
func ApplyHidden(root string, files []File) error {
	return writeFiles(root, files)
}

func writeFiles(root string, files []File) error {
	for _, f := range files {
		abs := filepath.Join(root, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasSuffix(f.Path, ".sh") {
			mode = 0o755
		}
		if err := os.WriteFile(abs, []byte(f.Content), mode); err != nil {
			return err
		}
	}
	return nil
}

// git runs git in dir, failing on error.
func git(dir string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		panic("git " + strings.Join(args, " ") + ": " + string(out))
	}
	return string(out)
}

func gitOut(dir string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(out)
}
