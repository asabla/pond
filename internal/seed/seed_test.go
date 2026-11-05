package seed

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/asabla/pond/internal/lake"
)

func TestSplitSQL(t *testing.T) {
	src := `-- people
CREATE TABLE a AS SELECT 'x;y' AS s, "we;ird" AS t;
/* a; comment */ INSERT INTO a VALUES ('it''s; fine', 'z');

SELECT $$dollar; quoted$$, $tag$more;$tag$;
-- trailing comment only;
`
	got := SplitSQL(src)
	want := []string{
		"-- people\nCREATE TABLE a AS SELECT 'x;y' AS s, \"we;ird\" AS t",
		"/* a; comment */ INSERT INTO a VALUES ('it''s; fine', 'z')",
		"SELECT $$dollar; quoted$$, $tag$more;$tag$",
	}
	if !slices.Equal(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
	if got := SplitSQL("SELECT 1"); !slices.Equal(got, []string{"SELECT 1"}) {
		t.Errorf("no semicolon: %q", got)
	}
	// Block comments nest, as in DuckDB: the inner */ doesn't end the outer comment.
	nested := "/* outer /* inner; */ still; comment */ SELECT 1; SELECT 2"
	if got := SplitSQL(nested); !slices.Equal(got, []string{"/* outer /* inner; */ still; comment */ SELECT 1", "SELECT 2"}) {
		t.Errorf("nested: %q", got)
	}
}

func TestCommentsInsideQuotesStay(t *testing.T) {
	if got := stripComments(`-- note
CREATE CATALOG "a--b" /* x */`); got != `CREATE CATALOG "a--b"` {
		t.Errorf("got %q", got)
	}
	f := &fakeLake{}
	dir := project(t, map[string]string{"01.sql": `CREATE CATALOG "a--b"; CREATE SCHEMA "a--b".s`})
	if err := Run(context.Background(), f, dir, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"catalog: a--b", "schema: a--b.s"}; !slices.Equal(f.calls, want) {
		t.Errorf("calls %q, want %q", f.calls, want)
	}
}

type fakeLake struct {
	calls  []string
	failOn string
	run    lake.RunResult
	hang   bool
}

func (f *fakeLake) ExecSQL(_ context.Context, stmt string) error {
	f.calls = append(f.calls, "sql: "+stmt)
	if f.failOn != "" && strings.Contains(stmt, f.failOn) {
		return errors.New("boom")
	}
	return nil
}

func (f *fakeLake) CreateCatalog(_ context.Context, name string, ifNotExists bool) error {
	if ifNotExists {
		name += " (if not exists)"
	}
	f.calls = append(f.calls, "catalog: "+name)
	return nil
}

func (f *fakeLake) CreateSchema(_ context.Context, catalog, name string, ifNotExists bool) error {
	name = catalog + "." + name
	if ifNotExists {
		name += " (if not exists)"
	}
	f.calls = append(f.calls, "schema: "+name)
	return nil
}

func (f *fakeLake) RunPython(ctx context.Context, name, path, _ string) (*lake.RunResult, error) {
	f.calls = append(f.calls, "python: "+name+" at "+path)
	if f.hang {
		<-ctx.Done() // a run that never terminates
		return nil, ctx.Err()
	}
	r := f.run
	return &r, nil
}

func project(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, Dir), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, Dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestRunsFilesInNameOrder(t *testing.T) {
	dir := project(t, map[string]string{
		"02_tables.sql":  "CREATE SCHEMA IF NOT EXISTS shop.raw; CREATE TABLE shop.raw.t AS SELECT 1",
		"01_catalog.sql": "-- catalogs\ncreate catalog if not exists shop;\nCREATE CATALOG `other` -- second",
		"03_more.py":     "print('hi')",
		"README.md":      "ignored",
	})
	f := &fakeLake{run: lake.RunResult{OK: true, State: "SUCCESS"}}
	if err := Run(context.Background(), f, dir, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"catalog: shop (if not exists)",
		"catalog: other",
		"schema: shop.raw (if not exists)",
		"sql: CREATE TABLE shop.raw.t AS SELECT 1",
		"python: seed: 03_more.py at /Shared/pond/seed/03_more.py",
	}
	if !slices.Equal(f.calls, want) {
		t.Errorf("calls %q\nwant %q", f.calls, want)
	}
}

func TestStopsAtFirstFailure(t *testing.T) {
	dir := project(t, map[string]string{
		"01.sql": "SELECT 1;\nSELECT broken;\nSELECT 3",
		"02.sql": "SELECT 4",
	})
	f := &fakeLake{failOn: "broken"}
	err := Run(context.Background(), f, dir, func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "01.sql") || !strings.Contains(err.Error(), "statement 2") {
		t.Errorf("err = %v", err)
	}
	if len(f.calls) != 2 {
		t.Errorf("ran past the failure: %q", f.calls)
	}
}

func TestReportsFailedPythonRun(t *testing.T) {
	dir := project(t, map[string]string{"gen.py": "raise SystemExit(1)"})
	f := &fakeLake{run: lake.RunResult{RunID: 7, State: "FAILED", Error: "exit 1", Logs: "Traceback...\n26/11/04 10:34:41 INFO ShutdownHookManager: Shutdown hook called\n"}}
	err := Run(context.Background(), f, dir, func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "run 7 ended failed: exit 1\nTraceback...") {
		t.Errorf("err = %v", err)
	}
}

func TestPythonSeedTimesOut(t *testing.T) {
	defer func(d time.Duration) { PythonTimeout = d }(PythonTimeout)
	PythonTimeout = 50 * time.Millisecond
	dir := project(t, map[string]string{"load.py": "while True: pass"})
	err := Run(context.Background(), &fakeLake{hang: true}, dir, func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "did not finish within 50ms") {
		t.Errorf("err = %v", err)
	}
}

func TestNoSeedFolderIsNotAnError(t *testing.T) {
	f := &fakeLake{}
	if err := Run(context.Background(), f, t.TempDir(), func(string, ...any) {}); err != nil || len(f.calls) != 0 {
		t.Errorf("err = %v, calls = %q", err, f.calls)
	}
}
