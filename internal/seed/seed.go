// Package seed fills a fresh lake from scripts committed next to the project.
//
// Seeds generate their data rather than ship it: `pond-seed/` holds `.sql` and `.py`
// files that run in name order. Saved graphs and queries come from .pond.json files.
// SQL files may hold several statements, and may create
// catalogs with `CREATE CATALOG [IF NOT EXISTS] name`, which pond runs through Unity
// Catalog because MiniLake's DuckDB has no such statement. Python files run as one-off
// jobs, so they can use PySpark.
package seed

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/asabla/pond/internal/lake"
)

// Dir is the folder, relative to the context directory, that holds seed scripts.
const Dir = "pond-seed"

// WorkspaceDir is where Python seeds are saved in the lake's workspace.
const WorkspaceDir = "/Shared/pond/seed"

// Lake is the part of the MiniLake client seeding uses.
type Lake interface {
	ExecSQL(ctx context.Context, statement string) error
	CreateCatalog(ctx context.Context, name string, ifNotExists bool) error
	CreateSchema(ctx context.Context, catalog, name string, ifNotExists bool) error
	RunPython(ctx context.Context, name, path, source string) (*lake.RunResult, error)
	SeedArtifacts(ctx context.Context, artifacts SavedArtifacts) error
}

// Files returns the seed scripts in dir in the order they run, or nil when there are none.
func Files(dir string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(dir, Dir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if ext := filepath.Ext(e.Name()); !e.IsDir() && (ext == ".sql" || ext == ".py" || strings.HasSuffix(e.Name(), ".pond.json")) {
			files = append(files, filepath.Join(dir, Dir, e.Name()))
		}
	}
	slices.Sort(files)
	return files, nil
}

// Run runs every seed script in dir, stopping at the first failure.
func Run(ctx context.Context, l Lake, dir string, logf func(string, ...any)) error {
	files, err := Files(dir)
	if err != nil || len(files) == 0 {
		return err
	}
	noun := "files"
	if len(files) == 1 {
		noun = "file"
	}
	logf("Seeding from %s/ (%d %s)…", Dir, len(files), noun)
	for _, path := range files {
		name := filepath.Base(path)
		logf("  %s", name)
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		switch {
		case strings.HasSuffix(name, ".pond.json"):
			err = runArtifacts(ctx, l, src)
		case filepath.Ext(name) == ".sql":
			err = runSQL(ctx, l, string(src))
		default:
			err = runPython(ctx, l, name, string(src))
		}
		if err != nil {
			return fmt.Errorf("seed %s: %w", name, err)
		}
	}
	logf("Seeded.")
	return nil
}

const ident = "(\\w+|`[^`]+`|\"[^\"]+\")"

var (
	createCatalog = regexp.MustCompile("(?is)^create\\s+catalog\\s+(if\\s+not\\s+exists\\s+)?" + ident + "$")
	createSchema  = regexp.MustCompile("(?is)^create\\s+schema\\s+(if\\s+not\\s+exists\\s+)?" + ident + "\\." + ident + "$")
)

func unquote(name string) string { return strings.Trim(name, "`\"") }

func runSQL(ctx context.Context, l Lake, src string) error {
	for i, stmt := range SplitSQL(src) {
		var err error
		bare := stripComments(stmt)
		if m := createCatalog.FindStringSubmatch(bare); m != nil {
			err = l.CreateCatalog(ctx, unquote(m[2]), m[1] != "")
		} else if m := createSchema.FindStringSubmatch(bare); m != nil {
			err = l.CreateSchema(ctx, unquote(m[2]), unquote(m[3]), m[1] != "")
		} else {
			err = l.ExecSQL(ctx, stmt)
		}
		if err != nil {
			return fmt.Errorf("statement %d (%s): %w", i+1, firstLine(stmt), err)
		}
	}
	return nil
}

// PythonTimeout bounds one Python seed, so a Spark run that never ends can't hang
// seeding forever.
var PythonTimeout = time.Hour

func runPython(ctx context.Context, l Lake, name, src string) error {
	ctx, cancel := context.WithTimeout(ctx, PythonTimeout)
	defer cancel()
	res, err := l.RunPython(ctx, "seed: "+name, WorkspaceDir+"/"+name, src)
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("did not finish within %s", PythonTimeout)
	}
	if err != nil {
		return err
	}
	if !res.OK {
		msg := strings.TrimSpace(res.Error)
		if logs := strings.TrimSpace(sparkNoise.ReplaceAllString(res.Logs, "")); logs != "" {
			msg += "\n" + tail(logs, 20)
		}
		return fmt.Errorf("run %d ended %s: %s", res.RunID, strings.ToLower(res.State), msg)
	}
	return nil
}

// sparkNoise matches Spark's own INFO and WARN lines, which bury a script's traceback.
var sparkNoise = regexp.MustCompile(`(?m)^\d\d/\d\d/\d\d \d\d:\d\d:\d\d (INFO|WARN) .*\n?`)

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	if len(line) > 60 {
		line = line[:57] + "..."
	}
	return line
}

func tail(s string, n int) string {
	lines := strings.Split(s, "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n")
}

// SplitSQL splits a script into statements on semicolons outside quotes and comments,
// dropping empty statements. Comments are kept with the statement they precede.
func SplitSQL(src string) []string {
	var out []string
	start := 0
	emit := func(end int) {
		if stmt := strings.TrimSpace(src[start:end]); stripComments(stmt) != "" {
			out = append(out, stmt)
		}
	}
	for i := 0; i < len(src); i++ {
		switch {
		case src[i] == '\'' || src[i] == '"' || src[i] == '`':
			i = skipQuoted(src, i, src[i])
		case strings.HasPrefix(src[i:], "--"):
			i = skipTo(src, i, "\n")
		case strings.HasPrefix(src[i:], "/*"):
			i = skipBlockComment(src, i)
		case src[i] == '$':
			if tag := dollarTag(src[i:]); tag != "" {
				i = skipTo(src, i+len(tag), tag) + len(tag) - 1
			}
		case src[i] == ';':
			emit(i)
			start = i + 1
		}
	}
	emit(len(src))
	return out
}

// skipQuoted returns the index of the closing quote; a doubled quote is an escaped one.
func skipQuoted(s string, i int, q byte) int {
	for i++; i < len(s); i++ {
		if s[i] == q {
			if i+1 < len(s) && s[i+1] == q {
				i++
				continue
			}
			return i
		}
	}
	return len(s)
}

// skipTo returns the index where end starts, at or after i, or the end of s.
func skipTo(s string, i int, end string) int {
	if j := strings.Index(s[i:], end); j >= 0 {
		return i + j
	}
	return len(s)
}

var dollarTagRE = regexp.MustCompile(`^\$[A-Za-z_]*\$`)

func dollarTag(s string) string { return dollarTagRE.FindString(s) }

// skipBlockComment returns the index of the "/" closing the comment that starts at i.
// Block comments nest, as in DuckDB.
func skipBlockComment(s string, i int) int {
	depth := 0
	for i < len(s) {
		switch {
		case strings.HasPrefix(s[i:], "/*"):
			depth++
			i += 2
		case strings.HasPrefix(s[i:], "*/"):
			depth--
			i += 2
			if depth == 0 {
				return i - 1
			}
		default:
			i++
		}
	}
	return len(s)
}

// stripComments removes comments outside quotes, so "a--b" stays a name.
func stripComments(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '\'' || s[i] == '"' || s[i] == '`':
			j := skipQuoted(s, i, s[i])
			b.WriteString(s[i:min(j+1, len(s))])
			i = j
		case strings.HasPrefix(s[i:], "--"):
			i = skipTo(s, i, "\n") - 1 // keep the newline
		case strings.HasPrefix(s[i:], "/*"):
			i = skipBlockComment(s, i)
			b.WriteByte(' ')
		case s[i] == '$' && dollarTag(s[i:]) != "":
			tag := dollarTag(s[i:])
			j := skipTo(s, i+len(tag), tag) + len(tag) - 1
			b.WriteString(s[i:min(j+1, len(s))])
			i = j
		default:
			b.WriteByte(s[i])
		}
	}
	return strings.TrimSpace(b.String())
}
