// Command pond runs a MiniLake context for a directory and serves the UI on top.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"pond/internal/lake"
	"pond/internal/pondctx"
	"pond/internal/server"
	"pond/web"
)

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const (
	defaultPort  = 8700
	portAttempts = 20
	usage        = `Run a MiniLake for a directory, with a UI, MCP and WebMCP on top.

Usage:
  pond [up] [DIR] [flags]   start the context for DIR (default: current directory)
  pond ls                   list running contexts
  pond down [DIR]           stop the context for DIR and remove its containers (keeps data)
  pond version              print the version

Flags for up:
  --port N       UI port (default: 8700, or the next free one)
  --host HOST    UI bind host (default: 127.0.0.1, env POND_HOST)
  --image IMAGE  MiniLake image (default: ghcr.io/dmux/minilake:1.9.0, env POND_MINILAKE_IMAGE)
  --minilake URL use an already running MiniLake at this URL instead of starting a container
                 (env MINILAKE_URL)
  --open         open the UI in a browser
`
)

type args struct {
	command      string
	dir          string
	port         int
	portExplicit bool
	host         string
	image        string
	minilake     string
	open         bool
}

var errHelp = errors.New("help requested")

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

func main() {
	a, err := parse(os.Args[1:])
	if errors.Is(err, errHelp) {
		fmt.Print(usage)
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "pond: %v\n\n%s", err, usage)
		os.Exit(2)
	}
	switch a.command {
	case "up":
		err = up(a)
	case "ls":
		err = ls()
	case "down":
		err = down(a)
	case "version":
		fmt.Println("pond", version)
	}
	if err != nil {
		logf("pond: %v", err)
		os.Exit(1)
	}
}

func parse(argv []string) (*args, error) {
	// Bare `pond` and `pond <dir>` mean `pond up`.
	if len(argv) == 0 || !slices.Contains([]string{"up", "ls", "down", "version", "-h", "--help"}, argv[0]) {
		argv = append([]string{"up"}, argv...)
	}
	if argv[0] == "-h" || argv[0] == "--help" {
		return nil, errHelp
	}
	a := &args{command: argv[0], dir: "."}
	fs := flag.NewFlagSet(a.command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	port := fs.Int("port", 0, "")
	if a.command == "up" {
		fs.StringVar(&a.host, "host", envOr("POND_HOST", "127.0.0.1"), "")
		fs.StringVar(&a.image, "image", pondctx.DefaultImage(), "")
		fs.StringVar(&a.minilake, "minilake", os.Getenv("MINILAKE_URL"), "")
		fs.BoolVar(&a.open, "open", false, "")
	}
	// Flags may follow the directory, as in `pond up DIR --open`.
	var positional []string
	rest := argv[1:]
	for {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, errHelp
			}
			return nil, err
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	if a.command == "ls" || a.command == "version" {
		if len(positional) > 0 || flagSet(fs, "port") {
			return nil, fmt.Errorf("unexpected argument for %s", a.command)
		}
	}
	if (a.command == "down") && flagSet(fs, "port") {
		return nil, errors.New("unknown flag: -port")
	}
	if len(positional) > 1 {
		return nil, fmt.Errorf("unexpected argument %q", positional[1])
	}
	if len(positional) == 1 {
		a.dir = positional[0]
	}
	if a.command == "up" {
		envPort := os.Getenv("POND_PORT")
		a.portExplicit = flagSet(fs, "port") || envPort != ""
		a.port = *port
		if a.port == 0 {
			a.port = defaultPort
			if envPort != "" {
				p, err := strconv.Atoi(envPort)
				if err != nil {
					return nil, fmt.Errorf("invalid POND_PORT %q", envPort)
				}
				a.port = p
			}
		}
	}
	return a, nil
}

func flagSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) { set = set || f.Name == name })
	return set
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

// bind listens on the requested port, falling back to the next free one from the default.
func bind(host string, port int, explicit bool) (net.Listener, error) {
	candidates := []int{port}
	if !explicit {
		for p := defaultPort; p < defaultPort+portAttempts; p++ {
			if p != port {
				candidates = append(candidates, p)
			}
		}
	}
	var last error
	for _, p := range candidates {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err == nil {
			return ln, nil
		}
		last = err
	}
	tried := make([]string, len(candidates))
	for i, p := range candidates {
		tried[i] = strconv.Itoa(p)
	}
	return nil, fmt.Errorf("No free port for the UI (tried %s): %v", strings.Join(tried, ", "), last)
}

func up(a *args) error {
	var c *pondctx.Context
	if a.minilake == "" {
		cc := pondctx.ForDir(a.dir)
		c = &cc
		if st, err := os.Stat(c.Dir); err != nil || !st.IsDir() {
			return fmt.Errorf("%s is not a directory", c.Dir)
		}
		if info := pondctx.RunningPID(*c); info != nil {
			logf("pond · %s is already running: %s", c.Name(), info.UI)
			return nil
		}
	}

	// SIGTERM (`pond down`, a closed terminal) cleans up the same way Ctrl-C does.
	sig, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	var srv *http.Server
	defer func() {
		stopSignals() // a second Ctrl-C during cleanup kills pond
		if srv != nil {
			srv.Close()
		}
		if c != nil {
			logf("\nStopping MiniLake…")
			pondctx.Stop(*c)
			os.Remove(c.RunFile())
		}
	}()

	var url string
	var described *pondctx.Description
	dataRoot := ""
	if c != nil {
		logf("pond · %s  (%s)", c.Name(), c.Dir)
		logf("Starting MiniLake…")
		var err error
		if url, err = pondctx.Start(sig, *c, a.image, func(s string) { logf("%s", s) }); err != nil {
			if sig.Err() != nil {
				return nil
			}
			return err
		}
		described, dataRoot = c.Describe(), pondctx.DataDir
	} else {
		url = strings.TrimRight(a.minilake, "/")
	}
	client, err := lake.New(url)
	if err != nil {
		return err
	}
	static, err := fs.Sub(web.FS, "static")
	if err != nil {
		return err
	}

	port := a.port
	if !a.portExplicit && c != nil {
		if p := c.PreferredPort(); p != 0 {
			port = p
		}
	}
	ln, err := bind(a.host, port, a.portExplicit)
	if err != nil {
		return err
	}
	var ctxInfo any
	if described != nil {
		ctxInfo = described
	}
	srv = &http.Server{Handler: server.New(server.Options{
		Host: a.host, Lake: client, Context: ctxInfo, DataRoot: dataRoot, Static: static, Version: version,
	})}

	uiPort := ln.Addr().(*net.TCPAddr).Port
	ui := fmt.Sprintf("http://localhost:%d", uiPort)
	mcpName := "pond"
	if c != nil {
		mcpName = "pond-" + c.Name()
		info, _ := json.Marshal(pondctx.RunInfo{PID: os.Getpid(), UI: ui, Minilake: url})
		if err := os.WriteFile(c.RunFile(), info, 0o644); err != nil {
			return err
		}
		if err := os.WriteFile(c.PortFile(), []byte(strconv.Itoa(uiPort)), 0o644); err != nil {
			return err
		}
	}
	logf("  UI    %s/", ui)
	logf("  MCP   %s/mcp", ui)
	logf("        claude mcp add --transport http %s %s/mcp", mcpName, ui)
	if c != nil {
		logf("  Data  %s", c.StateDir()+"/data")
		logf("Ctrl-C stops this context's containers. Data is kept.")
	} else {
		logf("  Lake  %s (not managed by pond)", url)
	}
	if a.open {
		openBrowser(ui + "/")
	}

	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	select {
	case <-sig.Done():
		return nil
	case err := <-served:
		return err
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if cmd.Start() == nil {
		go cmd.Wait()
	}
}

func ls() error {
	running, err := pondctx.List()
	if err != nil {
		return err
	}
	if len(running) == 0 {
		logf("No running pond contexts.")
		return nil
	}
	rows := [][]string{{"NAME", "UI", "DIR", "STATUS"}}
	for _, r := range running {
		ui := r.UI
		if ui == "" {
			ui = "-"
		}
		rows = append(rows, []string{r.Name, ui, r.Dir, r.Status})
	}
	var widths [3]int
	for _, r := range rows {
		for i := range widths {
			widths[i] = max(widths[i], len([]rune(r[i])))
		}
	}
	for _, r := range rows {
		cells := make([]string, 3)
		for i := range cells {
			cells[i] = r[i] + strings.Repeat(" ", widths[i]-len([]rune(r[i])))
		}
		fmt.Println(strings.Join(cells, "  "), r[3])
	}
	return nil
}

func down(a *args) error {
	c := pondctx.ForDir(a.dir)
	if info := pondctx.RunningPID(c); info != nil {
		// Let the running pond clean up after itself.
		proc, err := os.FindProcess(info.PID)
		if err == nil {
			err = proc.Signal(syscall.SIGTERM)
		}
		if err != nil {
			return err
		}
		logf("Asked pond (pid %d) to stop %s.", info.PID, c.Name())
		return nil
	}
	pondctx.Stop(c)
	os.Remove(c.RunFile())
	logf("Removed containers for %s. Data in %s is kept.", c.Name(), c.StateDir())
	return nil
}
