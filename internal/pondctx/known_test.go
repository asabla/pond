package pondctx

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestKnownContextsListsRunningThenRecent(t *testing.T) {
	f := setup(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))

	// Create the folder first: ForDir resolves symlinks (/var is /private/var on macOS).
	stoppedDir := filepath.Join(t.TempDir(), "stopped")
	os.MkdirAll(filepath.Join(stoppedDir, ".pond", "data"), 0o755)
	stopped := ForDir(stoppedDir)
	gone := ForDir(filepath.Join(t.TempDir(), "gone")) // no lake data: left out
	Remember(gone)
	Remember(stopped)
	Remember(f.ctx)
	Remember(stopped) // moves to the front, once

	lock, err := Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	WriteRunFile(f.ctx, RunInfo{PID: os.Getpid(), UI: "http://localhost:8700"})
	row, _ := json.Marshal(map[string]string{"Dir": f.ctx.Dir, "Status": "Up 1 minute"})
	t.Setenv("FAKE_PS", string(row))

	got := KnownContexts()
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].ID != f.ctx.ID() || !got[0].Running || got[0].UI != "http://localhost:8700" {
		t.Errorf("running: %+v", got[0])
	}
	if got[1].ID != stopped.ID() || got[1].Running {
		t.Errorf("stopped: %+v", got[1])
	}
	if dirs := readRecent(); len(dirs) != 3 || dirs[0] != stopped.Dir {
		t.Errorf("recent = %v", dirs)
	}
}
