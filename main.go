// Command pond runs a MiniLake context for a directory and serves the UI on top.
package main

import (
	"context"
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

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/internal/pondctx"
	"github.com/asabla/pond/internal/server"
	"github.com/asabla/pond/web"
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
  pond open [DIR]           open the UI of a running context in a browser
  pond logs [DIR] [flags]   show the context's MiniLake logs
  pond version              print the version

Flags for up:
  --port N       UI port (default: 8700, or the next free one)
  --host HOST    UI bind host (default: 127.0.0.1, env POND_HOST)
  --image IMAGE  MiniLake image (default: ghcr.io/dmux/minilake:1.9.0, env POND_MINILAKE_IMAGE)
  --minilake URL use an already running MiniLake at this URL instead of starting a container
                 (env MINILAKE_URL)
  --open         open the UI in a browser

Flags for logs:
  -f, --follow   keep printing new log lines
  --tail N       lines to show from the end (default: 200, "all" for everything)
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
	follow       bool
	tail         string
}

var commands = []string{"up", "ls", "down", "open", "logs", "version"}

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
	case "open":
		err = openContext(a)
	case "logs":
		err = logs(a)
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
	if len(argv) == 0 || !slices.Contains(append(commands, "-h", "--help"), argv[0]) {
		argv = append([]string{"up"}, argv...)
	}
	if argv[0] == "-h" || argv[0] == "--help" {
		return nil, errHelp
	}
	a := &args{command: argv[0], dir: "."}
	fs := flag.NewFlagSet(a.command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	var port *int
	switch a.command {
	case "up":
		port = fs.Int("port", 0, "")
		fs.StringVar(&a.host, "host", envOr("POND_HOST", "127.0.0.1"), "")
		fs.StringVar(&a.image, "image", pondctx.DefaultImage(), "")
		fs.StringVar(&a.minilake, "minilake", os.Getenv("MINILAKE_URL"), "")
		fs.BoolVar(&a.open, "open", false, "")
	case "logs":
		fs.BoolVar(&a.follow, "follow", false, "")
		fs.BoolVar(&a.follow, "f", false, "")
		fs.StringVar(&a.tail, "tail", "200", "")
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
	if a.command == "logs" && a.tail != "all" {
		if n, err := strconv.Atoi(a.tail); err != nil || n < 0 {
			return nil, fmt.Errorf("--tail takes a line count or \"all\", got %q", a.tail)
		}
	}
	if (a.command == "ls" || a.command == "version") && len(positional) > 0 {
		return nil, fmt.Errorf("unexpected argument for %s", a.command)
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

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// machineNames are the names other machines may use to reach this one: its hostname and
// interface addresses. Accepting only these keeps DNS-rebinding pages out while shared.
func machineNames() []string {
	var names []string
	if h, err := os.Hostname(); err == nil {
		names = append(names, h)
		if !strings.Contains(h, ".") {
			names = append(names, h+".local")
		}
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			names = append(names, n.IP.String())
		}
	}
	return names
}

func up(a *args) error {
	var c *pondctx.Context
	if a.minilake == "" {
		cc := pondctx.ForDir(a.dir)
		c = &cc
		if st, err := os.Stat(c.Dir); err != nil || !st.IsDir() {
			return fmt.Errorf("%s is not a directory", c.Dir)
		}
		lock, err := pondctx.Acquire(*c)
		if errors.Is(err, pondctx.ErrRunning) {
			if info := pondctx.Serving(*c); info != nil && info.UI != "" {
				logf("pond · %s is already running: %s", c.Name(), info.UI)
			} else {
				logf("pond · %s is already starting in another terminal.", c.Name())
			}
			return nil
		}
		if err != nil {
			return err
		}
		defer lock.Release()
		if err := pondctx.WriteRunFile(*c, pondctx.RunInfo{PID: os.Getpid()}); err != nil {
			return err
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
	shared := !isLoopback(a.host)
	var allowedHosts []string
	if shared {
		allowedHosts = machineNames()
	}
	srv = &http.Server{Handler: server.New(server.Options{
		Host: a.host, AllowedHosts: allowedHosts, Lake: client, Context: ctxInfo, DataRoot: dataRoot,
		Static: static, Version: version,
	})}

	uiPort := ln.Addr().(*net.TCPAddr).Port
	if c != nil && !a.portExplicit && port != uiPort && port == c.PreferredPort() {
		logf("! Port %d, where this context usually runs, is in use; using %d for this run.", port, uiPort)
		logf("  MCP clients registered at port %d won't reach it. Re-register with the command below,", port)
		logf("  or free port %d and restart pond.", port)
	}
	ui := fmt.Sprintf("http://localhost:%d", uiPort)
	mcpName := "pond"
	if c != nil {
		mcpName = "pond-" + c.Name()
		if err := pondctx.WriteRunFile(*c, pondctx.RunInfo{PID: os.Getpid(), UI: ui, Minilake: url}); err != nil {
			return err
		}
		// Keep the remembered port when this run fell back, so the next run returns to it.
		if c.PreferredPort() == 0 || a.portExplicit {
			if err := os.WriteFile(c.PortFile(), []byte(strconv.Itoa(uiPort)), 0o644); err != nil {
				return err
			}
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
	if shared {
		logf("")
		logf("! Shared on %s: anyone who can reach port %d can read and change this lake and", a.host, uiPort)
		logf("  run code in it. MiniLake has no authentication. Use the default host to keep it local.")
		for _, name := range allowedHosts {
			if ip := net.ParseIP(name); ip != nil && ip.To4() != nil && !ip.IsLoopback() {
				logf("  Others can open http://%s:%d/", name, uiPort)
			}
		}
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

// serving returns the running pond for DIR, or an error saying how to start it.
func serving(dir string) (pondctx.Context, *pondctx.RunInfo, error) {
	c := pondctx.ForDir(dir)
	info := pondctx.Serving(c)
	if info == nil || info.UI == "" {
		return c, nil, fmt.Errorf("%s is not running. Start it with `%s`", c.Name(), startCommand(dir))
	}
	return c, info, nil
}

func startCommand(dir string) string {
	if dir == "." {
		return "pond"
	}
	return "pond " + dir
}

func openContext(a *args) error {
	_, info, err := serving(a.dir)
	if err != nil {
		return err
	}
	openBrowser(info.UI + "/")
	return nil
}

func logs(a *args) error {
	c := pondctx.ForDir(a.dir)
	if !pondctx.Exists(c) {
		return fmt.Errorf("%s has no MiniLake container. Start it with `%s`", c.Name(), startCommand(a.dir))
	}
	cmd := pondctx.LogsCommand(c, a.follow, a.tail)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Ctrl-C reaches docker directly and ends `logs -f`; pond just waits for it.
	signal.Ignore(os.Interrupt)
	err := cmd.Run()
	if cmd.ProcessState != nil && !cmd.ProcessState.Exited() {
		return nil // stopped by Ctrl-C
	}
	return err
}

func down(a *args) error {
	c := pondctx.ForDir(a.dir)
	if info := pondctx.Serving(c); info != nil {
		if info.PID <= 0 {
			return fmt.Errorf("%s is running, but %s has no pid; stop it with Ctrl-C in its terminal", c.Name(), c.RunFile())
		}
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
