package pondctx

import (
	"encoding/json"
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
	path, err := recentFile()
	if err != nil {
		return
	}
	dirs := slices.DeleteFunc(readRecent(), func(d string) bool { return d == c.Dir })
	dirs = append([]string{c.Dir}, dirs...)
	if len(dirs) > maxRecent {
		dirs = dirs[:maxRecent]
	}
	b, err := json.Marshal(dirs)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(path), 0o755) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
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
