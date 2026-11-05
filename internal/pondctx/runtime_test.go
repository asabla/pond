package pondctx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRuntimeSelectionPinsConnectionAndEngineSocket(t *testing.T) {
	f := setup(t)
	self, _ := os.Executable()
	bin, _, _ := strings.Cut(os.Getenv("PATH"), string(os.PathListSeparator))
	if err := os.Symlink(self, filepath.Join(bin, "podman")); err != nil {
		t.Fatal(err)
	}
	if err := f.ctx.ConfigureRuntime(context.Background(), "podman", "", "", "img:1", false); err != nil {
		t.Fatal(err)
	}
	r := f.ctx.Runtime
	if r.Kind != "podman" || r.Socket != "/run/user/1000/podman/podman.sock" || r.Version != "5.test" {
		t.Fatalf("runtime: %+v", r)
	}
	t.Setenv("CONTAINER_HOST", "unix:///wrong.sock")
	t.Setenv("DOCKER_CONTEXT", "wrong-context")
	restored := ForDir(f.ctx.Dir)
	cmd := LogsCommand(context.Background(), restored, false, "10")
	if !slices.Contains(cmd.Args, r.Endpoint) || !slices.Contains(cmd.Args, r.Identity) || slices.Contains(cmd.Args, "wrong-context") {
		t.Fatalf("logs do not retain the original endpoint: %v", cmd.Args)
	}
	if slices.ContainsFunc(cmd.Env, func(item string) bool {
		return strings.HasPrefix(item, "CONTAINER_HOST=") || strings.HasPrefix(item, "DOCKER_CONTEXT=")
	}) {
		t.Fatal("default-connection overrides leaked into a pinned command")
	}
	if _, err := restored.command(context.Background(), true, "inspect", restored.Container()); err != nil {
		t.Fatal(err)
	}
	calls := f.calls()
	last := calls[len(calls)-1]
	if last[0] != "--url" || last[1] != r.Endpoint {
		t.Fatalf("wrong engine endpoint: %v", last)
	}
}

func TestDockerProvidersUseExistingContextsWithoutChangingDefaults(t *testing.T) {
	setup(t)
	for _, provider := range []string{"colima", "orbstack", "rancher-desktop"} {
		r, err := ResolveRuntime(context.Background(), provider, "", "/engine/custom.sock")
		if err != nil {
			t.Fatal(err)
		}
		if r.Kind != "docker" || r.Provider != provider || r.Connection != provider || r.Socket != "/engine/custom.sock" {
			t.Fatalf("provider selection: %+v", r)
		}
	}
}

func TestRuntimeMigrationRequiresBackupAndPreservesStoppedData(t *testing.T) {
	f := setup(t)
	if err := f.ctx.ConfigureRuntime(context.Background(), "colima", "", "", "img:1", false); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.ctx.DataPath(), "table.bin"), "existing lake")
	if err := f.ctx.ConfigureRuntime(context.Background(), "colima", "", "", "img:2", false); err == nil || !strings.Contains(err.Error(), "--migrate-runtime") {
		t.Fatalf("image changed without migration: %v", err)
	}
	if ForDir(f.ctx.Dir).Runtime.Image != "img:1" {
		t.Fatal("failed migration changed runtime metadata")
	}
	if err := f.ctx.ConfigureRuntime(context.Background(), "colima", "", "", "img:2", true); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(f.ctx.StateDir(), "before-runtime-change-*.pond.tar.gz"))
	if len(backups) != 1 {
		t.Fatalf("backups: %v", backups)
	}
	backup, err := os.Open(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	restored := ForDir(t.TempDir())
	if err := Import(restored, backup); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(restored.DataPath(), "table.bin"))
	if err != nil || string(data) != "existing lake" {
		t.Fatalf("backup not restorable: %q %v", data, err)
	}
}

func TestMalformedRuntimeAndForeignResourcesNeverFallBackToCleanup(t *testing.T) {
	f := setup(t)
	os.MkdirAll(f.ctx.StateDir(), 0o755)
	write(t, f.ctx.RuntimeFile(), `{"kind":"unexpected","endpoint":"unix:///x","socket":"/x"}`)
	broken := ForDir(f.ctx.Dir)
	if err := Stop(broken); err == nil {
		t.Fatal("invalid runtime accepted")
	}
	if len(f.calls()) != 0 {
		t.Fatal("invalid runtime fell back to another engine")
	}
	t.Setenv("FAKE_WRONG_OWNER", "1")
	if err := Stop(f.ctx); err == nil {
		t.Fatal("foreign ownership accepted")
	}
	for _, call := range f.calls() {
		if call[0] == "stop" || call[0] == "rm" {
			t.Fatalf("foreign resources changed: %v", call)
		}
	}
}

func TestFailedGracefulStopDoesNotForceRemoveTheLake(t *testing.T) {
	f := setup(t)
	t.Setenv("FAKE_STOP_FAIL", "1")
	if err := Stop(f.ctx); err == nil {
		t.Fatal("stop failure hidden")
	}
	for _, call := range f.calls() {
		if call[0] == "rm" || (call[0] == "network" && call[1] == "rm") {
			t.Fatalf("removed resources after failed persistence: %v", call)
		}
	}
}

func TestManagedRuntimeRejectsRemoteOrPasswordEndpoints(t *testing.T) {
	for _, endpoint := range []string{"tcp://remote:2375", "ssh://user@remote/run/podman.sock", "ssh://user:secret@127.0.0.1/run/podman.sock"} {
		r := Runtime{Kind: "podman", Endpoint: endpoint, Socket: "/run/podman.sock"}
		if err := r.validate(); err == nil {
			t.Fatalf("unsafe managed endpoint accepted: %s", endpoint)
		}
	}
}

func TestPodmanStartupUsesItsSocketWithoutDockerCLI(t *testing.T) {
	f := setup(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// This directory is created by this test. Installed executables are neither
	// changed nor placed on the PATH used by the child process.
	bin := t.TempDir()
	if err := os.Symlink(self, filepath.Join(bin, "podman")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if err := f.ctx.ConfigureRuntime(context.Background(), "podman", "", "", "img:1", false); err != nil {
		t.Fatal(err)
	}
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{}`)) }))
	defer health.Close()
	t.Setenv("FAKE_PORT", strings.TrimPrefix(health.URL, "http://127.0.0.1:"))
	t.Setenv("FAKE_MOUNT", f.ctx.DataPath())
	if _, err := Start(context.Background(), f.ctx, "img:1", func(string) {}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, call := range f.calls() {
		if slices.Contains(call, "run") {
			found = true
			if !slices.Contains(call, "type=bind,source=/run/user/1000/podman/podman.sock,target=/var/run/docker.sock") {
				t.Fatalf("wrong engine socket mount: %v", call)
			}
		}
	}
	if !found {
		t.Fatal("no container start")
	}
}

func TestUnavailableEngineIsNotTreatedAsAbsentResources(t *testing.T) {
	f := setup(t)
	t.Setenv("FAKE_SOCKET_MISSING", "1")
	if _, err := CheckExists(f.ctx); err == nil {
		t.Fatal("missing engine socket treated as missing container")
	}
	if err := Stop(f.ctx); err == nil {
		t.Fatal("cleanup succeeded with an unavailable engine")
	}
	if _, err := os.Stat(filepath.Join(f.ctx.StateDir(), "stopped")); err == nil {
		t.Fatal("unavailable engine marked clean")
	}
}
