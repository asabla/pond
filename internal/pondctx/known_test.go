package pondctx

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
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

func recentHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
}

func TestForgetKeepsDataAndOtherEntriesWithoutAnEngine(t *testing.T) {
	f := setup(t)
	recentHome(t)
	if err := PrepareStateDir(f.ctx); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.ctx.DataPath(), "sample.txt"), "keep lake data")
	other := ForDir(t.TempDir())
	if err := PrepareStateDir(other); err != nil {
		t.Fatal(err)
	}
	Remember(other)
	Remember(f.ctx)
	cache.Lock()
	cache.at, cache.value = time.Now(), []Known{{ID: f.ctx.ID()}}
	cache.Unlock()
	t.Setenv("PATH", t.TempDir()) // forgetting must not invoke a container CLI
	if err := Forget(f.ctx); err != nil {
		t.Fatal(err)
	}
	if dirs := readRecent(); len(dirs) != 1 || dirs[0] != other.Dir {
		t.Fatalf("wrong entries removed: %v", dirs)
	}
	if data, err := os.ReadFile(filepath.Join(f.ctx.DataPath(), "sample.txt")); err != nil || string(data) != "keep lake data" {
		t.Fatalf("lake data changed: %q %v", data, err)
	}
	if got := CachedKnownContexts(time.Hour); len(got) != 1 || got[0].ID != other.ID() {
		t.Fatalf("cached list was not refreshed: %+v", got)
	}
	if err := Forget(f.ctx); err != nil {
		t.Fatalf("repeat removal: %v", err)
	}
	Remember(f.ctx)
	if dirs := readRecent(); len(dirs) != 2 || dirs[0] != f.ctx.Dir {
		t.Fatalf("context cannot be added again: %v", dirs)
	}
}

func TestForgetRefusesAContextWithAStartupLock(t *testing.T) {
	recentHome(t)
	c := ForDir(t.TempDir())
	Remember(c)
	lock, err := Acquire(c)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	// There is no run.json/UI yet. A held lock still means this context is active.
	if err := Forget(c); !errors.Is(err, ErrRunning) {
		t.Fatalf("active context removal: %v", err)
	}
	if dirs := readRecent(); len(dirs) != 1 || dirs[0] != c.Dir {
		t.Fatalf("active entry removed: %v", dirs)
	}
}

func TestForgetMissingProjectAndCorruptRegistry(t *testing.T) {
	recentHome(t)
	c := ForDir(filepath.Join(t.TempDir(), "missing"))
	Remember(c)
	if err := Forget(c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(c.Dir); !os.IsNotExist(err) {
		t.Fatalf("forget created a project directory: %v", err)
	}
	path, _ := recentFile()
	write(t, path, "corrupt JSON")
	if err := Forget(c); err == nil {
		t.Fatal("corrupt list overwritten without an error")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "corrupt JSON" {
		t.Fatal("corrupt list was changed")
	}
}

func TestConcurrentRememberAndForgetPreserveOtherEntries(t *testing.T) {
	recentHome(t)
	removed := ForDir(t.TempDir())
	Remember(removed)
	var contexts []Context
	for range 12 {
		contexts = append(contexts, ForDir(t.TempDir()))
	}
	var group sync.WaitGroup
	group.Go(func() {
		if err := Forget(removed); err != nil {
			t.Error(err)
		}
	})
	for _, c := range contexts {
		group.Go(func() { Remember(c) })
	}
	group.Wait()
	dirs := readRecent()
	if len(dirs) != len(contexts) {
		t.Fatalf("concurrent updates lost entries: %v", dirs)
	}
	for _, c := range contexts {
		found := false
		for _, dir := range dirs {
			found = found || dir == c.Dir
		}
		if !found {
			t.Errorf("missing %s", c.Dir)
		}
	}
}
