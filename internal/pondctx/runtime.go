package pondctx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Runtime pins both the host connection and the engine-side socket mounted into
// MiniLake. The host's forwarded socket is not necessarily a path inside its VM.
type Runtime struct {
	Kind       string `json:"kind"`
	Provider   string `json:"provider"`
	Endpoint   string `json:"endpoint"`
	Connection string `json:"connection,omitempty"`
	Socket     string `json:"socket"`
	Identity   string `json:"identity,omitempty"` // SSH key path; never key contents
	Version    string `json:"version,omitempty"`
	Image      string `json:"image,omitempty"`
}

// RuntimeFile is separate from run.json so a restart keeps using the same engine.
func (c Context) RuntimeFile() string { return filepath.Join(c.StateDir(), "runtime.json") }

// RuntimeError reports an unreadable or invalid saved runtime selection.
func (c Context) RuntimeError() error { return c.runtimeErr }

func loadRuntime(c *Context) {
	b, err := os.ReadFile(c.RuntimeFile())
	if os.IsNotExist(err) {
		return
	}
	if err == nil {
		var r Runtime
		err = json.Unmarshal(b, &r)
		if err == nil {
			err = r.validate()
		}
		if err == nil {
			c.Runtime = &r
		}
	}
	if err != nil {
		c.runtimeErr = fmt.Errorf("read %s: %w; repair this file before managing the context", c.RuntimeFile(), err)
	}
}

func (r Runtime) validate() error {
	if r.Kind != "docker" && r.Kind != "podman" {
		return fmt.Errorf("unknown runtime %q", r.Kind)
	}
	u, err := url.Parse(r.Endpoint)
	if err != nil || u == nil || u.Path == "" || (u.Scheme != "unix" && u.Scheme != "ssh") {
		return errors.New("managed runtimes need a local Unix socket or a local Podman machine connection; use --minilake for an external service")
	}
	if u.User != nil {
		if _, password := u.User.Password(); password {
			return errors.New("runtime endpoints must not contain passwords")
		}
	}
	if u.Scheme == "ssh" && (r.Kind != "podman" || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1")) {
		return errors.New("managed SSH runtimes must be a local Podman machine; use --minilake for a remote service")
	}
	if !filepath.IsAbs(r.Socket) || strings.ContainsAny(r.Socket, "\r\n") {
		return errors.New("runtime socket must be an absolute engine-side path")
	}
	return nil
}

func cli(ctx context.Context, binary string, args []string, pinned bool) (string, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	if pinned {
		cmd.Env = runtimeEnv()
	}
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	err := cmd.Run()
	if errors.Is(err, exec.ErrNotFound) {
		if binary == "docker" {
			return "", errors.New("Docker CLI not found. Select --runtime podman, install a Docker-compatible provider, or attach with --minilake URL")
		}
		return "", fmt.Errorf("%s CLI not found. Install the selected runtime and configure a local service or machine", binary)
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(out.String())
		}
		return "", fmt.Errorf("%s failed: %s: %w", binary, detail, err)
	}
	return strings.TrimSpace(out.String()), nil
}

func runtimeEnv() []string {
	var env []string
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		switch key {
		case "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CONTAINER_HOST", "CONTAINER_CONNECTION":
			continue
		}
		env = append(env, item)
	}
	return env
}

func (r Runtime) args(args ...string) []string {
	flag := "--host"
	if r.Kind == "podman" {
		flag = "--url"
	}
	out := []string{flag, r.Endpoint}
	if r.Kind == "podman" && r.Identity != "" {
		out = append(out, "--identity", r.Identity)
	}
	return append(out, args...)
}

// Probe checks a connection without creating containers or changing the engine.
func (r *Runtime) Probe(ctx context.Context) error {
	if err := r.validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	format := "{{json .}}"
	if r.Kind == "podman" {
		format = "json"
	}
	out, err := cli(ctx, r.Kind, r.args("info", "--format", format), true)
	if err != nil {
		return fmt.Errorf("cannot reach %s (%s): %w. Check service/VM state and socket permissions; run `pond doctor`", r.Provider, r.Connection, err)
	}
	var info struct {
		ServerVersion string                   `json:"ServerVersion"`
		Version       struct{ Version string } `json:"version"`
	}
	if err := json.Unmarshal([]byte(out), &info); err != nil {
		return fmt.Errorf("read %s engine information: %w", r.Kind, err)
	}
	r.Version = info.ServerVersion
	if r.Kind == "podman" {
		r.Version = info.Version.Version
	}
	return nil
}

// ResolveRuntime reads a provider's existing CLI connection. It never starts a VM
// and never switches the CLI's default context.
func ResolveRuntime(ctx context.Context, selection, connection, socket string) (*Runtime, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if selection == "" {
		selection = "docker"
	}
	r := &Runtime{Kind: selection, Provider: selection, Connection: connection, Socket: socket}
	switch selection {
	case "colima", "orbstack", "rancher-desktop":
		r.Kind = "docker"
		if r.Connection == "" {
			r.Connection = selection
		}
	case "docker", "podman":
	default:
		return nil, fmt.Errorf("unknown runtime %q; choose docker, colima, orbstack, rancher-desktop or podman", selection)
	}
	if r.Kind == "docker" {
		if r.Connection == "" {
			r.Connection = os.Getenv("DOCKER_CONTEXT")
			if r.Connection == "" {
				r.Endpoint = os.Getenv("DOCKER_HOST")
			}
		}
		if r.Endpoint == "" {
			if r.Connection == "" {
				name, err := cli(ctx, "docker", []string{"context", "show"}, false)
				if err != nil {
					return nil, err
				}
				r.Connection = name
			}
			endpoint, err := cli(ctx, "docker", []string{"context", "inspect", r.Connection, "--format", "{{.Endpoints.docker.Host}}"}, false)
			if err != nil {
				return nil, err
			}
			r.Endpoint = endpoint
		}
		if selection == "docker" && r.Connection != "" {
			r.Provider = r.Connection
		}
		if r.Socket == "" {
			r.Socket = "/var/run/docker.sock"
			if runtime.GOOS == "linux" && !strings.HasPrefix(r.Connection, "colima") && r.Connection != "orbstack" && r.Connection != "rancher-desktop" && r.Connection != "desktop-linux" {
				if u, err := url.Parse(r.Endpoint); err == nil && u.Scheme == "unix" {
					r.Socket = u.Path
				}
			}
		}
	} else {
		if err := resolvePodman(ctx, r); err != nil {
			return nil, err
		}
	}
	if err := r.Probe(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

func resolvePodman(ctx context.Context, r *Runtime) error {
	out, err := cli(ctx, "podman", []string{"system", "connection", "list", "--format", "json"}, false)
	if err != nil {
		return err
	}
	var connections []struct {
		Name, URI, Identity string
		Default             bool
	}
	if err := json.Unmarshal([]byte(out), &connections); err != nil {
		return fmt.Errorf("read Podman connections: %w", err)
	}
	for _, connection := range connections {
		if (r.Connection != "" && connection.Name == r.Connection) || (r.Connection == "" && connection.Default) {
			r.Connection, r.Endpoint, r.Identity = connection.Name, connection.URI, connection.Identity
			break
		}
	}
	if r.Endpoint == "" && r.Connection == "" && runtime.GOOS == "linux" {
		out, err = cli(ctx, "podman", []string{"info", "--format", "json"}, false)
		if err != nil {
			return err
		}
		var info struct {
			Host struct{ RemoteSocket struct{ Path string } }
		}
		if err := json.Unmarshal([]byte(out), &info); err != nil {
			return err
		}
		r.Endpoint = "unix://" + info.Host.RemoteSocket.Path
	}
	if r.Endpoint == "" {
		return errors.New("Podman connection not found. Configure a local Podman service or machine, then choose it with --connection")
	}
	if r.Socket == "" {
		u, err := url.Parse(r.Endpoint)
		if err != nil {
			return err
		}
		r.Socket = u.Path
	}
	return nil
}

// ConfigureRuntime persists a verified selection while the caller holds the context
// lock. An explicit migration backs up stopped data before changing the selection.
func (c *Context) ConfigureRuntime(ctx context.Context, selection, connection, socket, image string, migrate bool) error {
	if c.runtimeErr != nil {
		return c.runtimeErr
	}
	previous := c.Runtime
	var chosen *Runtime
	if previous != nil && selection == "" && connection == "" && socket == "" {
		copy := *previous
		chosen = &copy
		if err := chosen.Probe(ctx); err != nil {
			return err
		}
	} else {
		if selection == "" && previous != nil {
			selection = previous.Kind
		}
		var err error
		chosen, err = ResolveRuntime(ctx, selection, connection, socket)
		if err != nil {
			return err
		}
	}
	chosen.Image = image
	changed := previous != nil && (previous.Kind != chosen.Kind || previous.Endpoint != chosen.Endpoint || previous.Socket != chosen.Socket || previous.Identity != chosen.Identity || (previous.Image != "" && previous.Image != image))
	if changed && !Fresh(*c) {
		if !migrate {
			return errors.New("this context uses another runtime connection or image. Stop it, then pass --migrate-runtime to create a data backup and change the selection")
		}
		backup := filepath.Join(c.StateDir(), fmt.Sprintf("before-runtime-change-%d.pond.tar.gz", time.Now().UnixNano()))
		f, err := os.OpenFile(backup, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		err = Export(*c, f)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			os.Remove(backup)
			return errors.Join(err, closeErr)
		}
		fmt.Fprintf(os.Stderr, "Runtime change backup: %s\n", backup)
	}
	if err := PrepareStateDir(*c); err != nil {
		return fmt.Errorf("cannot write project state: %w; check data ownership before changing runtime", err)
	}
	probe, err := os.CreateTemp(c.DataPath(), ".pond-access-")
	if err != nil {
		return fmt.Errorf("project data is not writable: %w; repair ownership before changing runtime", err)
	}
	probePath := probe.Name()
	closeErr := probe.Close()
	os.Remove(probePath)
	if closeErr != nil {
		return closeErr
	}
	b, err := json.MarshalIndent(chosen, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.RuntimeFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.RuntimeFile()); err != nil {
		return err
	}
	c.Runtime = chosen
	return nil
}

func (c Context) command(ctx context.Context, check bool, args ...string) (string, error) {
	if c.runtimeErr != nil {
		return "", c.runtimeErr
	}
	if c.Runtime == nil {
		return docker(ctx, check, args...)
	}
	if err := c.Runtime.validate(); err != nil {
		return "", err
	}
	out, err := cli(ctx, c.Runtime.Kind, c.Runtime.args(args...), true)
	var exit *exec.ExitError
	if !check && errors.As(err, &exit) && ctx.Err() == nil {
		return out, nil
	}
	return out, err
}
