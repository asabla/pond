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
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
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
	defaultImage = "ghcr.io/dmux/minilake:1.9.1"
	// Label marks pond's containers and networks; its value is the context ID.
	Label = "pond.context"
	// LabelDir records the context's directory on its containers.
	LabelDir     = "pond.dir"
	minilakePort = 8000
	// DataDir is MINILAKE_DATA_DIR inside the image; also reported to the UI as data_root.
	DataDir     = "/data"
	stopTimeout = 20 // seconds MiniLake gets to write its state snapshot
)

var errDockerNotFound = errors.New("Docker CLI not found. Install Docker Desktop, OrbStack or colima.")

// DefaultImage is the MiniLake image to run, unless POND_MINILAKE_IMAGE overrides it.
func DefaultImage() string {
	if v, ok := os.LookupEnv("POND_MINILAKE_IMAGE"); ok {
		return v
	}
	return defaultImage
}

// Context is a directory with its own lake: state in .pond/, plus its own container and network.
type Context struct {
	Dir        string
	Runtime    *Runtime
	runtimeErr error
}

// Description is what the UI learns about the context through /pond/config.
type Description struct {
	Name      string   `json:"name"`
	ID        string   `json:"id"`
	Dir       string   `json:"dir"`
	Container string   `json:"container"`
	Runtime   *Runtime `json:"runtime,omitempty"`
}

// ForDir returns the context for path, made absolute with ~ expanded and symlinks resolved.
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
	c := Context{Dir: abs}
	loadRuntime(&c)
	return c
}

var unsafeName = regexp.MustCompile(`[^a-z0-9_.-]+`)

// Name is the directory's base name, made safe for Docker names.
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

// StateDir is the context's .pond folder: lake data, lock, run and port files.
func (c Context) StateDir() string { return filepath.Join(c.Dir, ".pond") }

// Network is the Docker network MiniLake and its Spark job containers share.
func (c Context) Network() string { return "pond-" + c.ID() }

// Container is the name of the context's MiniLake container.
func (c Context) Container() string { return "pond-" + c.ID() + "-minilake" }

// RunFile describes the running pond (PID and URLs) while it holds the lock.
func (c Context) RunFile() string { return filepath.Join(c.StateDir(), "run.json") }

// SeedMarker exists while seeds run, so an interrupted or failed first seed is noticed.
func (c Context) SeedMarker() string { return filepath.Join(c.StateDir(), "seeding") }

// PortFile is kept between runs so the context's URLs, and MCP registrations using them, stay put.
func (c Context) PortFile() string { return filepath.Join(c.StateDir(), "port") }

// PreferredPort is the UI port of the last run, or 0 when there is none.
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

// Describe returns what the UI shows about the context.
func (c Context) Describe() *Description {
	return &Description{Name: c.Name(), ID: c.ID(), Dir: c.Dir, Container: c.Container(), Runtime: c.Runtime}
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
		return "", fmt.Errorf("docker %s failed: %s: %w", strings.Join(args[:min(2, len(args))], " "), detail, err)
	}
	return out, nil
}

// EnsureDocker checks that the docker CLI is installed and its daemon answers.
func EnsureDocker(ctx context.Context) error {
	_, err := docker(ctx, true, "info", "--format", "{{.ServerVersion}}")
	if err == nil || errors.Is(err, errDockerNotFound) {
		return err
	}
	return errors.New("Docker is not running. Start Docker Desktop, OrbStack or `colima start`, then retry.")
}

// RunInfo is the content of the run file.
type RunInfo struct {
	PID      int    `json:"pid"`
	UI       string `json:"ui,omitempty"`
	Minilake string `json:"minilake,omitempty"`
}

func (c Context) lockPath() string { return filepath.Join(c.StateDir(), "lock") }

// Lock is held by the pond serving a context for as long as it runs.
type Lock struct{ f *os.File }

// ErrRunning means another pond holds the context's lock.
var ErrRunning = errors.New("context is already running")

// Acquire takes the context's lock, or returns ErrRunning when another pond holds it.
// Holding it also covers startup, before any containers or URLs exist.
func Acquire(c Context) (*Lock, error) {
	// Another pond probing the lock (Serving) holds it for an instant; retry briefly so a
	// `pond ls` in another terminal can't make this look like a running context.
	for i := 0; ; i++ {
		l, err := tryLock(c)
		if !errors.Is(err, ErrRunning) || i == 4 {
			if err == nil {
				// Holding the lock means no pond is running here, so a run file is
				// left over from one that was killed. Its PID may be reused by now.
				os.Remove(c.RunFile())
				if err = RecoverImport(c); err != nil {
					l.Release()
					return nil, fmt.Errorf("recovering an interrupted import: %w", err)
				}
			}
			return l, err
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func tryLock(c Context) (*Lock, error) {
	if err := os.MkdirAll(c.StateDir(), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(c.lockPath(), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	ok, err := lockFile(f)
	if !ok {
		f.Close()
		if err == nil {
			err = ErrRunning
		}
		return nil, err
	}
	return &Lock{f}, nil
}

// Release lets other pond commands use the context. It is safe on a nil Lock.
func (l *Lock) Release() {
	if l != nil {
		l.f.Close()
	}
}

// Serving returns the pond serving this context, or nil when none is.
//
// The run file alone is not trusted: after a crash or reboot its PID may belong to an
// unrelated process. Only a held lock proves a pond is alive.
func Serving(c Context) *RunInfo {
	if _, err := os.Stat(c.lockPath()); err != nil {
		return nil
	}
	l, err := tryLock(c)
	if err == nil {
		l.Release()
		return nil
	}
	if !errors.Is(err, ErrRunning) {
		return nil
	}
	info := RunInfo{}
	if b, err := os.ReadFile(c.RunFile()); err == nil {
		_ = json.Unmarshal(b, &info) // a damaged run file only loses the URLs
	}
	return &info
}

// WriteRunFile records how to reach the pond serving c. Call it while holding the lock.
func WriteRunFile(c Context, info RunInfo) error {
	b, err := json.Marshal(info)
	if err != nil {
		return err
	}
	// Write and rename, so a reader never sees half a file.
	tmp := c.RunFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.RunFile())
}

// bindMount builds a --mount value. Its fields are CSV, so quoting keeps commas and
// colons in the path intact (-v would split on the colon).
func bindMount(src, dst string) string {
	var b strings.Builder
	w := csv.NewWriter(&b)
	_ = w.Write([]string{"type=bind", "source=" + src, "target=" + dst}) // a Builder can't fail
	w.Flush()
	return strings.TrimSuffix(b.String(), "\n")
}

// PrepareStateDir creates .pond/data and a .gitignore that keeps .pond out of the repo.
func PrepareStateDir(c Context) error {
	if err := os.MkdirAll(c.DataPath(), 0o755); err != nil {
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
	if c.Runtime != nil {
		if err := c.Runtime.Probe(ctx); err != nil {
			return "", err
		}
	} else if err := EnsureDocker(ctx); err != nil {
		return "", err
	}
	if err := Stop(c); err != nil { //nolint:contextcheck // cleanup must finish even when startup was cancelled
		return "", err
	}
	if err := PrepareStateDir(c); err != nil {
		return "", err
	}

	if out, err := c.command(ctx, true, "image", "ls", "-q", image); err != nil {
		return "", err
	} else if out == "" {
		onStatus(fmt.Sprintf("Pulling %s (first run only)…", image))
		if _, err := c.command(ctx, true, "pull", "-q", image); err != nil {
			return "", err
		}
	}

	labels := []string{"--label", Label + "=" + c.ID(), "--label", LabelDir + "=" + c.Dir}
	// An explicit host port survives an engine-driven restart of this container.
	// Docker's empty HostPort allocates a new port on each container start.
	listener, err := new(net.ListenConfig).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		listener.Close()
		return "", errors.New("cannot allocate a local MiniLake port")
	}
	hostPort := address.Port
	if err := listener.Close(); err != nil {
		return "", err
	}
	os.Remove(filepath.Join(c.StateDir(), "stopped"))
	if _, err := c.command(ctx, true, append([]string{"network", "create"}, append(labels, c.Network())...)...); err != nil {
		return "", err
	}
	run := []string{"run", "-d", "--name", c.Container(), "--network", c.Network()}
	run = append(run, labels...)
	run = append(run,
		"-p", fmt.Sprintf("127.0.0.1:%d:%d", hostPort, minilakePort),
		"--mount", bindMount(c.DataPath(), DataDir),
		// MiniLake starts Spark job containers as siblings through the host's Docker.
		"--mount", bindMount(c.socketPath(), "/var/run/docker.sock"),
		"-e", "MINILAKE_MCP=1",
		"-e", "MINILAKE_PERSIST=1",
		"-e", "MINILAKE_DOCKER_NETWORK="+c.Network(),
		"-e", "MINILAKE_NOTEBOOK=0",
		image,
	)
	if _, err := c.command(ctx, true, run...); err != nil {
		// Docker Desktop refuses outright to mount a path it doesn't share.
		if msg := err.Error(); strings.Contains(msg, "bind source path does not exist") || strings.Contains(msg, "mounts denied") {
			if strings.Contains(msg, c.socketPath()) {
				return "", fmt.Errorf("engine socket %s cannot be mounted: %w. Set --runtime-socket to the engine-side path, not the host-forwarded path", c.socketPath(), err)
			}
			return "", mountError(c)
		}
		return "", err
	}
	if err := checkMount(ctx, c); err != nil {
		return "", err
	}
	if c.Runtime != nil {
		if _, err := c.command(ctx, true, "exec", c.Container(), "python", "-c", `import docker; c = docker.from_env(); c.ping()`); err != nil {
			return "", fmt.Errorf("MiniLake cannot access the engine API through %s: %w. Check socket permissions and any host security policy; run pond doctor", c.socketPath(), err)
		}
	}
	out, err := c.command(ctx, true, "port", c.Container(), fmt.Sprintf("%d/tcp", minilakePort))
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
	seen, err := c.command(ctx, true, "exec", c.Container(), "cat", DataDir+"/.pond-mount")
	os.Remove(marker)
	if err != nil {
		// A container that crashed on start can't run cat either; say that, with its logs,
		// rather than blaming the mount.
		if exited := exitedError(ctx, c); exited != nil {
			return exited
		}
		seen = "" // the marker isn't there: the container sees an empty folder
	}
	if seen != c.ID() {
		return mountError(c)
	}
	return nil
}

func mountError(c Context) error {
	return fmt.Errorf("Docker-compatible runtime cannot see %s, so data would not land in %s.\n"+
		"Share this path with your Docker VM (colima and Docker Desktop share your home "+
		"directory by default), or run pond from a directory under it.", c.Dir, c.StateDir())
}

// exitedError reports, with its last log lines, a MiniLake container that stopped.
func exitedError(ctx context.Context, c Context) error {
	// Only a definite "false" is a crash; a failed inspect may just be docker hiccuping.
	if running, err := c.command(ctx, true, "inspect", "-f", "{{.State.Running}}", c.Container()); err == nil && running == "false" {
		logs, _ := c.command(ctx, false, "logs", "--tail", "30", c.Container())
		return fmt.Errorf("MiniLake container exited during startup:\n%s", logs)
	}
	return nil
}

func waitHealthy(ctx context.Context, c Context, url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/_minilake/health", nil)
		if err != nil {
			return err
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if err := exitedError(ctx, c); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("MiniLake did not become healthy within %ds. See `pond logs %q`.", int(timeout.Seconds()), c.Dir)
}

// Stop removes the context's containers and network. Data in `.pond/` is kept.
// It ignores cancellation so cleanup after Ctrl-C still completes.
func Stop(c Context) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	container, err := c.owned(ctx, "container", c.Container())
	if err != nil {
		return err
	}
	network, err := c.owned(ctx, "network", c.Network())
	if err != nil {
		return err
	}
	attached := ""
	if network {
		attached, err = c.command(ctx, true, "network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", c.Network())
		if err != nil {
			return err
		}
	}
	// A failed graceful stop must never be followed by forced removal of lake data.
	if container {
		if _, err := c.command(ctx, true, "stop", "-t", strconv.Itoa(stopTimeout), c.Container()); err != nil {
			return err
		}
	}
	rm := []string{"rm", "-f"}
	if container {
		rm = append(rm, c.Container())
	}
	for name := range strings.FieldsSeq(attached) {
		if name != c.Container() {
			rm = append(rm, name)
		}
	}
	if len(rm) > 2 {
		if _, err := c.command(ctx, true, rm...); err != nil {
			return err
		}
	}
	if network {
		if _, err := c.command(ctx, true, "network", "rm", c.Network()); err != nil {
			return err
		}
	}
	if _, err := os.Stat(c.StateDir()); err == nil {
		return os.WriteFile(filepath.Join(c.StateDir(), "stopped"), []byte("clean shutdown\n"), 0o644)
	}
	return nil
}

func (c Context) socketPath() string {
	if c.Runtime != nil {
		return c.Runtime.Socket
	}
	return "/var/run/docker.sock"
}

func (c Context) owned(ctx context.Context, kind, name string) (bool, error) {
	field := `{{index .Config.Labels "pond.context"}}`
	if kind == "network" {
		field = `{{index .Labels "pond.context"}}`
	}
	label, err := c.command(ctx, true, kind, "inspect", "-f", field, name)
	if missingResource(err, kind, name) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if label != c.ID() {
		return false, fmt.Errorf("refusing to remove %s %s: context ownership label does not match", kind, name)
	}
	return true, nil
}

func missingResource(err error, kind, name string) bool {
	if err == nil {
		return false
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return false
	}
	message := strings.ToLower(err.Error())
	return (strings.Contains(message, "no such container") || strings.Contains(message, "no such object") || strings.Contains(message, "no such network")) || (kind == "network" && (strings.Contains(message, "network "+strings.ToLower(name)+" not found") || strings.Contains(message, "network not found")))
}

// CheckExists distinguishes an absent container from an unavailable engine.
func CheckExists(c Context) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.command(ctx, true, "inspect", "-f", "{{.Id}}", c.Container())
	if missingResource(err, "container", c.Container()) {
		return false, nil
	}
	return err == nil, err
}

// Exists reports whether the context's MiniLake container exists, running or not.
func Exists(c Context) bool {
	_, err := c.command(context.Background(), true, "inspect", "-f", "{{.Id}}", c.Container())
	return err == nil
}

// LogsCommand prints the context's MiniLake logs. tail is a line count or "all".
func LogsCommand(ctx context.Context, c Context, follow bool, tail string) *exec.Cmd {
	args := []string{"logs", "--tail", tail}
	if follow {
		args = append(args, "--follow")
	}
	args = append(args, c.Container())
	if c.Runtime != nil {
		cmd := exec.CommandContext(ctx, c.Runtime.Kind, c.Runtime.args(args...)...)
		cmd.Env = runtimeEnv()
		return cmd
	}
	return exec.CommandContext(ctx, "docker", args...)
}

// Running is one running context, as `pond ls` shows it.
type Running struct {
	Name, Dir, UI, Status string
}

// List returns running MiniLake containers started by Pond, across all directories.
func List() ([]Running, error) {
	// Ask for the label by name: the Labels column joins them with commas, which a
	// directory name can contain too.
	format := fmt.Sprintf(`{"Dir":{{json (.Label %q)}},"Status":{{json .Status}}}`, LabelDir)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := docker(ctx, false, "ps", "--filter", "label="+Label, "--format", format)
	if err != nil {
		return nil, err
	}
	var found []Running
	for line := range strings.SplitSeq(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var row struct{ Dir, Status string }
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, err
		}
		dir := row.Dir
		if dir == "" {
			dir = "."
		}
		c := ForDir(dir)
		r := Running{Name: c.Name(), Dir: c.Dir, Status: row.Status}
		if info := Serving(c); info != nil {
			r.UI = info.UI
		}
		found = append(found, r)
	}
	return found, nil
}
