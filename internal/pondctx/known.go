package pondctx

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// maxRecent bounds the list of directories pond remembers.
const maxRecent = 20

// Known is a context as the UI's context switcher shows it.
type Known struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Dir     string `json:"dir"`
	Running bool   `json:"running"`
	// UI is where the context's pond serves its UI, while it runs.
	UI string `json:"ui,omitempty"`
	// Status is Docker's description of its MiniLake container, such as "Up 5 minutes".
	Status string `json:"status,omitempty"`
}

// recentFile lists the directories pond has served, newest first, so the UI can offer
// contexts that are stopped too.
func recentFile() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pond", "recent.json"), nil
}

func readRecent() []string {
	path, err := recentFile()
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var dirs []string
	_ = json.Unmarshal(b, &dirs) // a damaged list only forgets recent contexts
	return dirs
}

// Remember records that c was served, moving it to the front of the recent list. It is
// best effort: the list only feeds the context switcher.
func Remember(c Context) {
	_ = changeRecent(func(dirs []string) []string {
		dirs = slices.DeleteFunc(dirs, func(d string) bool { return d == c.Dir })
		dirs = append([]string{c.Dir}, dirs...)
		return dirs[:min(len(dirs), maxRecent)]
	})
}

// Forget removes a stopped context from discovery. It never starts an engine,
// removes project files, or changes the running context's lifecycle.
func Forget(c Context) error {
	// Keep an existing context lock until the registry change finishes, so a
	// concurrent start cannot be forgotten while it is starting or serving.
	f, err := os.Open(c.lockPath())
	if err == nil {
		defer f.Close()
		locked, err := lockFile(f)
		if err != nil {
			return err
		}
		if !locked {
			return fmt.Errorf("%w: run pond down in %s before removing %s from the list", ErrRunning, c.Dir, c.Name())
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("check whether %s is running: %w", c.Name(), err)
	}
	return changeRecent(func(dirs []string) []string {
		return slices.DeleteFunc(dirs, func(dir string) bool { return ForDir(dir).Dir == c.Dir })
	})
}

// Serialize read/modify/write across Pond processes. Readers see an atomic rename.
// The registry lock is separate from a project's lifecycle lock.
func changeRecent(change func([]string) []string) error {
	path, err := recentFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer lock.Close()
	for attempt := 0; ; attempt++ {
		ok, err := lockFile(lock)
		if err != nil {
			return err
		}
		if ok {
			break
		}
		if attempt == 40 {
			return errors.New("the recent-context list is busy; retry the command")
		}
		time.Sleep(25 * time.Millisecond)
	}
	var dirs []string
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &dirs); err != nil {
			return fmt.Errorf("read recent-context list: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	b, err := json.Marshal(change(dirs))
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".recent-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	cache.Lock()
	cache.at, cache.value = time.Time{}, nil
	cache.Unlock()
	return nil
}

// KnownContexts returns the running contexts, then recently served ones that still have
// lake data, each once.
func KnownContexts() []Known {
	var out []Known
	seen := map[string]bool{}
	if running, err := List(); err == nil {
		for _, r := range running {
			c := ForDir(r.Dir)
			if seen[c.ID()] {
				continue
			}
			seen[c.ID()] = true
			out = append(out, Known{ID: c.ID(), Name: c.Name(), Dir: c.Dir, Running: r.UI != "", UI: r.UI, Status: r.Status})
		}
	}
	for _, dir := range readRecent() {
		c := ForDir(dir)
		if seen[c.ID()] {
			continue
		}
		if st, err := os.Stat(c.DataPath()); err != nil || !st.IsDir() {
			continue // the directory or its lake is gone
		}
		seen[c.ID()] = true
		k := Known{ID: c.ID(), Name: c.Name(), Dir: c.Dir}
		// A pond can serve a context while its container is still starting.
		if info := Serving(c); info != nil && info.UI != "" {
			k.Running, k.UI = true, info.UI
		}
		out = append(out, k)
	}
	return out
}

// cache keeps docker out of every request when the UI polls.
var cache struct {
	sync.Mutex
	at    time.Time
	value []Known
}

// CachedKnownContexts is KnownContexts, reused for up to ttl.
func CachedKnownContexts(ttl time.Duration) []Known {
	cache.Lock()
	defer cache.Unlock()
	if time.Since(cache.at) >= ttl {
		cache.at, cache.value = time.Now(), KnownContexts()
	}
	return cache.value
}
