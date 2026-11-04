// Package pondctx manages per-directory MiniLake contexts.
//
// A context is a directory plus everything Pond runs for it: a MiniLake container, the
// Docker network that container and its Spark job containers share, and `.pond/` in the
// directory holding the data. Two directories never share data, containers or ports.
//
// Pond drives Docker through its CLI so it needs no dependencies. MiniLake's job
// containers are unlabelled, so the per-context network is what scopes them: whatever is
// attached to it belongs to the context and is removed with it.
package pondctx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultImage = "ghcr.io/dmux/minilake:1.9.0"
	Label        = "pond.context"
	LabelDir     = "pond.dir"
	minilakePort = 8000
	// DataDir is MINILAKE_DATA_DIR inside the image; also reported to the UI as data_root.
	DataDir     = "/data"
	stopTimeout = 20 // seconds MiniLake gets to write its state snapshot
)

var errDockerNotFound = errors.New("Docker CLI not found. Install Docker Desktop, OrbStack or colima.")

func DefaultImage() string {
	if v, ok := os.LookupEnv("POND_MINILAKE_IMAGE"); ok {
		return v
	}
	return defaultImage
}

type Context struct {
	Dir string
}

// Description is what the UI learns about the context through /pond/config.
type Description struct {
	Name      string `json:"name"`
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Container string `json:"container"`
}

func ForDir(path string) Context {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[1:])
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = filepath.Clean(path)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return Context{Dir: abs}
}

var unsafeName = regexp.MustCompile(`[^a-z0-9_.-]+`)

func (c Context) Name() string {
	name := unsafeName.ReplaceAllString(strings.ToLower(filepath.Base(c.Dir)), "-")
	if name = strings.Trim(name, "-."); name == "" {
		return "root"
	}
	return name
}

// ID carries a hash so same-named directories (two `api/` folders) stay apart.
func (c Context) ID() string {
	sum := sha256.Sum256([]byte(c.Dir))
	return c.Name() + "-" + hex.EncodeToString(sum[:])[:6]
}

func (c Context) StateDir() string  { return filepath.Join(c.Dir, ".pond") }
func (c Context) Network() string   { return "pond-" + c.ID() }
func (c Context) Container() string { return "pond-" + c.ID() + "-minilake" }
func (c Context) RunFile() string   { return filepath.Join(c.StateDir(), "run.json") }

// PortFile is kept between runs so the context's URLs, and MCP registrations using them, stay put.
func (c Context) PortFile() string { return filepath.Join(c.StateDir(), "port") }

func (c Context) PreferredPort() int {
	b, err := os.ReadFile(c.PortFile())
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return port
}

func (c Context) Describe() *Description {
	return &Description{Name: c.Name(), ID: c.ID(), Dir: c.Dir, Container: c.Container()}
}

func docker(ctx context.Context, check bool, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if errors.Is(err, exec.ErrNotFound) {
		return "", errDockerNotFound
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return "", err
	}
	out := strings.TrimSpace(stdout.String())
	if err != nil && check {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = out
		}
		return "", fmt.Errorf("docker %s failed: %s", strings.Join(args[:min(2, len(args))], " "), detail)
	}
	return out, nil
}

func EnsureDocker() error {
	_, err := docker(context.Background(), true, "info", "--format", "{{.ServerVersion}}")
	if err == nil || errors.Is(err, errDockerNotFound) {
		return err
	}
	return errors.New("Docker is not running. Start Docker Desktop, OrbStack or `colima start`, then retry.")
}

type RunInfo struct {
	PID      int    `json:"pid"`
	UI       string `json:"ui"`
	Minilake string `json:"minilake"`
}

// RunningPID returns the live Pond process already serving this context, if any.
func RunningPID(c Context) *RunInfo {
	b, err := os.ReadFile(c.RunFile())
	if err != nil {
		return nil
	}
	var info RunInfo
	if json.Unmarshal(b, &info) != nil || info.PID <= 0 {
		return nil
	}
	proc, err := os.FindProcess(info.PID)
	if err != nil || proc.Signal(signal0) != nil {
		return nil
	}
	return &info
}

func PrepareStateDir(c Context) error {
	if err := os.MkdirAll(filepath.Join(c.StateDir(), "data"), 0o755); err != nil {
		return err
	}
	ignore := filepath.Join(c.StateDir(), ".gitignore")
	if _, err := os.Stat(ignore); err == nil {
		return nil
	}
	// Keeps lake data out of the repo the context lives in.
	return os.WriteFile(ignore, []byte("*\n"), 0o644)
}

// Start runs MiniLake for c and returns its base URL on the host.
func Start(ctx context.Context, c Context, image string, onStatus func(string)) (string, error) {
	if err := EnsureDocker(); err != nil {
		return "", err
	}
	Stop(c) // clear leftovers from a run that did not shut down cleanly
	if err := PrepareStateDir(c); err != nil {
		return "", err
	}

	if out, err := docker(ctx, true, "image", "ls", "-q", image); err != nil {
		return "", err
	} else if out == "" {
		onStatus(fmt.Sprintf("Pulling %s (first run only)…", image))
		if _, err := docker(ctx, true, "pull", "-q", image); err != nil {
			return "", err
		}
	}

	labels := []string{"--label", Label + "=" + c.ID(), "--label", LabelDir + "=" + c.Dir}
	if _, err := docker(ctx, true, append([]string{"network", "create"}, append(labels, c.Network())...)...); err != nil {
		return "", err
	}
	run := []string{"run", "-d", "--name", c.Container(), "--network", c.Network()}
	run = append(run, labels...)
	run = append(run,
		"-p", fmt.Sprintf("127.0.0.1::%d", minilakePort),
		"-v", filepath.Join(c.StateDir(), "data")+":"+DataDir,
		// MiniLake starts Spark job containers as siblings through the host's Docker.
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-e", "MINILAKE_MCP=1",
		"-e", "MINILAKE_PERSIST=1",
		"-e", "MINILAKE_DOCKER_NETWORK="+c.Network(),
		"-e", "MINILAKE_NOTEBOOK=0",
		image,
	)
	if _, err := docker(ctx, true, run...); err != nil {
		return "", err
	}
	if err := checkMount(ctx, c); err != nil {
		return "", err
	}
	out, err := docker(ctx, true, "port", c.Container(), fmt.Sprintf("%d/tcp", minilakePort))
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(out, "\n")
	i := strings.LastIndex(line, ":")
	if i < 0 {
		return "", fmt.Errorf("unexpected docker port output: %q", out)
	}
	url := "http://127.0.0.1:" + strings.TrimSpace(line[i+1:])
	return url, waitHealthy(ctx, c, url, 90*time.Second)
}

// checkMount fails fast when Docker cannot see the directory.
//
// Docker VMs (colima, Docker Desktop) only share some host paths. Outside them a bind
// mount silently becomes an empty directory inside the VM, and the lake's data would
// live there instead of in `.pond/`.
func checkMount(ctx context.Context, c Context) error {
	marker := filepath.Join(c.StateDir(), "data", ".pond-mount")
	if err := os.WriteFile(marker, []byte(c.ID()), 0o644); err != nil {
		return err
	}
	seen, err := docker(ctx, false, "exec", c.Container(), "cat", DataDir+"/.pond-mount")
	os.Remove(marker)
	if err != nil {
		return err
	}
	if seen != c.ID() {
		return fmt.Errorf("Docker cannot see %s, so data would not land in %s.\n"+
			"Share this path with your Docker VM (colima and Docker Desktop share your home "+
			"directory by default), or run pond from a directory under it.", c.Dir, c.StateDir())
	}
	return nil
}

func waitHealthy(ctx context.Context, c Context, url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if resp, err := client.Get(url + "/_minilake/health"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		running, err := docker(ctx, false, "inspect", "-f", "{{.State.Running}}", c.Container())
		if err != nil {
			return err
		}
		if running != "true" {
			logs, _ := docker(ctx, false, "logs", "--tail", "30", c.Container())
			return fmt.Errorf("MiniLake container exited during startup:\n%s", logs)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("MiniLake did not become healthy within %ds. See `docker logs %s`.", int(timeout.Seconds()), c.Container())
}

// Stop removes the context's containers and network. Data in `.pond/` is kept.
// It ignores cancellation so cleanup after Ctrl-C still completes.
func Stop(c Context) {
	bg := context.Background()
	// Graceful stop first so MINILAKE_PERSIST writes its snapshot.
	docker(bg, false, "stop", "-t", strconv.Itoa(stopTimeout), c.Container())
	attached, _ := docker(bg, false, "network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", c.Network())
	rm := []string{"rm", "-f", c.Container()}
	for _, name := range strings.Fields(attached) {
		if name != c.Container() {
			rm = append(rm, name)
		}
	}
	docker(bg, false, rm...)
	docker(bg, false, "network", "rm", c.Network())
}

type Running struct {
	Name, Dir, UI, Status string
}

// List returns running MiniLake containers started by Pond, across all directories.
func List() ([]Running, error) {
	out, err := docker(context.Background(), false, "ps", "--filter", "label="+Label, "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	var found []Running
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var row struct{ Labels, Status string }
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, err
		}
		labels := map[string]string{}
		for _, kv := range strings.Split(row.Labels, ",") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				labels[k] = v
			}
		}
		dir := labels[LabelDir]
		if dir == "" {
			dir = "."
		}
		c := ForDir(dir)
		r := Running{Name: c.Name(), Dir: c.Dir, Status: row.Status}
		if info := RunningPID(c); info != nil {
			r.UI = info.UI
		}
		found = append(found, r)
	}
	return found, nil
}
