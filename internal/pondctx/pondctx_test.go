package pondctx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const fakeDockerEnv = "POND_TEST_FAKE_DOCKER"

// TestMain lets the test binary stand in for the docker CLI: tests symlink a
// `docker` on PATH to it and set fakeDockerEnv.
func TestMain(m *testing.M) {
	if os.Getenv(fakeDockerEnv) != "" {
		os.Exit(fakeDocker(os.Args[1:]))
	}
	os.Exit(m.Run())
}

// fakeDocker records every call and answers the few Pond relies on.
func fakeDocker(args []string) int {
	line, _ := json.Marshal(args)
	if f, err := os.OpenFile(os.Getenv("FAKE_DOCKER_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		fmt.Fprintln(f, string(line))
		f.Close()
	}
	switch {
	case args[0] == "info" && os.Getenv("FAKE_DOCKER_DOWN") != "":
		return 1
	case args[0] == "network" && args[1] == "inspect":
		fmt.Println(os.Getenv("FAKE_ATTACHED"))
	case args[0] == "image" && args[1] == "ls":
		fmt.Println("sha256:abc")
	case args[0] == "exec":
		// `cat /data/.pond-mount`: read the marker through the host directory, like a real bind mount.
		if mount := os.Getenv("FAKE_MOUNT"); mount != "" {
			b, _ := os.ReadFile(filepath.Join(mount, ".pond-mount"))
			fmt.Println(string(b))
		}
	case args[0] == "port":
		fmt.Println("127.0.0.1:" + os.Getenv("FAKE_PORT"))
	case args[0] == "ps":
		fmt.Println(os.Getenv("FAKE_PS"))
	case args[0] == "inspect":
		fmt.Println("true")
	}
	return 0
}

type fixture struct {
	t   *testing.T
	log string
	ctx Context
}

func setup(t *testing.T) *fixture {
	t.Helper()
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self, filepath.Join(bin, "docker")); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(tmp, "docker.log")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv(fakeDockerEnv, "1")
	t.Setenv("FAKE_DOCKER_LOG", log)
	project := filepath.Join(tmp, "My Project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	return &fixture{t, log, ForDir(project)}
}

func (f *fixture) calls() [][]string {
	b, err := os.ReadFile(f.log)
	if err != nil {
		return nil
	}
	var out [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var call []string
		if json.Unmarshal([]byte(line), &call) == nil {
			out = append(out, call)
		}
	}
	return out
}

func TestNamesAreReadableAndUniquePerPath(t *testing.T) {
	f := setup(t)
	other := filepath.Join(filepath.Dir(f.ctx.Dir), "elsewhere", "My Project")
	os.MkdirAll(other, 0o755)
	if f.ctx.Name() != "my-project" || !strings.HasPrefix(f.ctx.ID(), "my-project-") {
		t.Errorf("name %q id %q", f.ctx.Name(), f.ctx.ID())
	}
	if f.ctx.ID() == ForDir(other).ID() {
		t.Error("same-named directories share an id")
	}
	if f.ctx.Network() != "pond-"+f.ctx.ID() || f.ctx.Container() != "pond-"+f.ctx.ID()+"-minilake" {
		t.Errorf("network %q container %q", f.ctx.Network(), f.ctx.Container())
	}
}

// Pins the algorithm so existing `.pond/` directories keep mapping to the same containers.
func TestIDMatchesPythonImplementation(t *testing.T) {
	// python3: hashlib.sha256(b"/tmp/Some.Dir_1").hexdigest()[:6]
	if got := (Context{Dir: "/tmp/Some.Dir_1"}).ID(); got != "some.dir_1-818b34" {
		t.Errorf("id %q", got)
	}
	if got := (Context{Dir: "/"}).Name(); got != "root" {
		t.Errorf("root name %q", got)
	}
}

func TestStateDirIgnoresItself(t *testing.T) {
	f := setup(t)
	if err := PrepareStateDir(f.ctx); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(f.ctx.StateDir(), ".gitignore"))
	if string(b) != "*\n" {
		t.Errorf(".gitignore = %q", b)
	}
	if st, err := os.Stat(filepath.Join(f.ctx.StateDir(), "data")); err != nil || !st.IsDir() {
		t.Error("data dir missing")
	}
}

func TestStopRemovesEverythingOnTheContextNetwork(t *testing.T) {
	f := setup(t)
	t.Setenv("FAKE_ATTACHED", "job-a job-b ")
	Stop(f.ctx)
	calls := f.calls()
	if calls[0][0] != "stop" {
		t.Errorf("graceful stop must come first, got %v", calls[0])
	}
	i := slices.IndexFunc(calls, func(c []string) bool { return len(c) > 1 && c[0] == "rm" && c[1] == "-f" })
	if i < 0 {
		t.Fatal("no rm -f")
	}
	got := slices.Clone(calls[i][2:])
	slices.Sort(got)
	want := []string{f.ctx.Container(), "job-a", "job-b"}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("rm -f %v, want %v", got, want)
	}
	if !slices.ContainsFunc(calls, func(c []string) bool { return slices.Equal(c, []string{"network", "rm", f.ctx.Network()}) }) {
		t.Error("network not removed")
	}
}

func TestStartScopesContainerToContext(t *testing.T) {
	f := setup(t)
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) }))
	defer health.Close()
	port := health.Listener.Addr().String()[strings.LastIndex(health.Listener.Addr().String(), ":")+1:]
	t.Setenv("FAKE_PORT", port)
	data := filepath.Join(f.ctx.StateDir(), "data")
	t.Setenv("FAKE_MOUNT", data)

	url, err := Start(context.Background(), f.ctx, "img:1", func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if url != "http://127.0.0.1:"+port {
		t.Errorf("url %q", url)
	}
	var run []string
	for _, c := range f.calls() {
		if c[0] == "run" {
			run = c
		}
	}
	for _, want := range []string{
		data + ":/data", "MINILAKE_DOCKER_NETWORK=" + f.ctx.Network(),
		"pond.context=" + f.ctx.ID(), "127.0.0.1::8000", "pond.dir=" + f.ctx.Dir,
	} {
		if !slices.Contains(run, want) {
			t.Errorf("run missing %q: %v", want, run)
		}
	}
	if i := slices.Index(run, "--network"); i < 0 || run[i+1] != f.ctx.Network() {
		t.Errorf("run network: %v", run)
	}
	if _, err := os.Stat(filepath.Join(data, ".pond-mount")); !os.IsNotExist(err) {
		t.Error("mount marker left behind")
	}
}

func TestStartRefusesPathsDockerCannotSee(t *testing.T) {
	f := setup(t)
	t.Setenv("FAKE_PORT", "1")
	// No FAKE_MOUNT: the container sees an empty directory, as with an unshared path.
	_, err := Start(context.Background(), f.ctx, "img:1", func(string) {})
	if err == nil || !strings.Contains(err.Error(), "Docker cannot see") {
		t.Errorf("err = %v", err)
	}
}

func TestReportsDockerNotRunning(t *testing.T) {
	setup(t)
	t.Setenv("FAKE_DOCKER_DOWN", "1")
	if err := EnsureDocker(); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Errorf("err = %v", err)
	}
}

func TestReportsDockerNotInstalled(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := EnsureDocker(); err == nil || !strings.Contains(err.Error(), "Docker CLI not found") {
		t.Errorf("err = %v", err)
	}
}

func TestServingTrustsTheLockNotThePID(t *testing.T) {
	f := setup(t)
	// A run file left by a crashed pond, naming a live but unrelated process.
	if err := os.MkdirAll(f.ctx.StateDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteRunFile(f.ctx, RunInfo{PID: os.Getppid(), UI: "x"}); err != nil {
		t.Fatal(err)
	}
	if Serving(f.ctx) != nil {
		t.Error("run file without a held lock reported as running")
	}

	lock, err := Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	WriteRunFile(f.ctx, RunInfo{PID: os.Getpid(), UI: "x"})
	if info := Serving(f.ctx); info == nil || info.UI != "x" || info.PID != os.Getpid() {
		t.Errorf("info = %v", info)
	}
	if _, err := Acquire(f.ctx); !errors.Is(err, ErrRunning) {
		t.Errorf("second Acquire = %v, want ErrRunning", err)
	}

	lock.Release()
	if Serving(f.ctx) != nil {
		t.Error("released lock still reported as running")
	}
	again, err := Acquire(f.ctx)
	if err != nil {
		t.Errorf("Acquire after Release: %v", err)
	}
	again.Release()
}

func TestListReadsLabelsAndRunFile(t *testing.T) {
	f := setup(t)
	if got, err := List(); err != nil || len(got) != 0 {
		t.Fatalf("empty list: %v, %v", got, err)
	}
	lock, err := Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	WriteRunFile(f.ctx, RunInfo{PID: os.Getpid(), UI: "http://localhost:8700"})
	row, _ := json.Marshal(map[string]string{
		"Labels": "pond.context=" + f.ctx.ID() + ",pond.dir=" + f.ctx.Dir, "Status": "Up 1 minute",
	})
	t.Setenv("FAKE_PS", string(row))
	got, err := List()
	want := []Running{{Name: "my-project", Dir: f.ctx.Dir, UI: "http://localhost:8700", Status: "Up 1 minute"}}
	if err != nil || !slices.Equal(got, want) {
		t.Errorf("got %v, %v", got, err)
	}
}
