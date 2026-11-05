// Command pond runs a MiniLake context for a directory and serves the UI on top.
package main

import (
	"bufio"
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
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/internal/pondctx"
	"github.com/asabla/pond/internal/seed"
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
  pond ls [--all]           list running contexts, or include stopped contexts
  pond forget [DIR]         remove a stopped context from the list (keeps data)
  pond down [DIR]           stop the context for DIR and remove its containers (keeps data)
  pond open [DIR]           open the UI of a running context in a browser
  pond logs [DIR] [flags]   show the context's MiniLake logs
  pond seed [DIR]           run DIR/pond-seed/ scripts against the running context
  pond reset [DIR] [--yes]  delete the context's lake data, then seed it again
  pond export [DIR] [-o FILE]       write the lake's data to a .tar.gz snapshot
  pond import FILE [DIR] [--yes]    replace the lake's data with a snapshot
  pond doctor [DIR] [flags]        check the stored runtime or an external MiniLake
  pond graph COMMAND [flags]       analyse graphs in a running context (graph --help for commands)
  pond version              print the version

Flags for up:
  --port N       UI port (default: 8700, or the next free one)
  --host HOST    UI bind host (default: 127.0.0.1, env POND_HOST)
  --image IMAGE  MiniLake image (default: ghcr.io/dmux/minilake:1.9.1, env POND_MINILAKE_IMAGE)
  --minilake URL use an already running MiniLake at this URL instead of starting a container
                 (env MINILAKE_URL)
  --runtime NAME select docker, colima, orbstack, rancher-desktop or podman (env POND_RUNTIME)
  --connection NAME  use an existing Docker context or Podman connection (env POND_CONNECTION)
  --runtime-socket PATH  engine-side API socket to mount into MiniLake (env POND_RUNTIME_SOCKET)
  --migrate-runtime  back up stopped data before changing its runtime connection or image
  --open         open the UI in a browser

doctor accepts --runtime, --connection, --runtime-socket or --minilake.
It checks the connection without creating containers or changing CLI defaults.

Flags for logs:
  -f, --follow   keep printing new log lines
  --tail N       lines to show from the end (default: 200, "all" for everything)

A new context runs the .sql and .py files in DIR/pond-seed/ in name order, so a project
can generate its sample data instead of shipping it. .pond.json files add missing saved
queries and graphs on every start, keeping existing definitions. export and import need
the context stopped (pond down).
`
)

type args struct {
	command        string
	all            bool
	dir            string
	port           int
	portExplicit   bool
	host           string
	image          string
	imageExplicit  bool
	minilake       string
	open           bool
	follow         bool
	tail           string
	yes            bool
	output         string
	file           string
	graph          *graphArgs
	runtime        string
	connection     string
	socket         string
	migrateRuntime bool
}

var commands = []string{"up", "ls", "forget", "down", "open", "logs", "seed", "reset", "export", "import", "version", "graph", "doctor"}

var errHelp = errors.New("help requested")

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

func main() {
	a, err := parse(os.Args[1:])
	if errors.Is(err, errGraphHelp) {
		fmt.Print(graphUsage)
		return
	}
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
		ls(a.all)
	case "forget":
		err = forget(a)
	case "down":
		err = down(a)
	case "open":
		err = openContext(a)
	case "logs":
		err = logs(a)
	case "seed":
		err = seedContext(a)
	case "reset":
		err = reset(a)
	case "export":
		err = export(a)
	case "import":
		err = importSnapshot(a)
	case "doctor":
		err = doctor(a)
	case "version":
		fmt.Println("pond", version)
	case "graph":
		err = graphCommand(a.graph, os.Stdout)
	}
	if err != nil {
		logf("pond: %v", err)
		os.Exit(1)
	}
}

func parse(argv []string) (*args, error) {
	if len(argv) > 0 && argv[0] == "graph" {
		return parseGraph(argv[1:])
	}
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
	if a.command == "up" || a.command == "doctor" {
		fs.StringVar(&a.runtime, "runtime", os.Getenv("POND_RUNTIME"), "")
		fs.StringVar(&a.connection, "connection", os.Getenv("POND_CONNECTION"), "")
		fs.StringVar(&a.socket, "runtime-socket", os.Getenv("POND_RUNTIME_SOCKET"), "")
	}
	switch a.command {
	case "ls":
		fs.BoolVar(&a.all, "all", false, "")
	case "doctor":
		fs.StringVar(&a.minilake, "minilake", os.Getenv("MINILAKE_URL"), "")
	case "up":
		fs.BoolVar(&a.migrateRuntime, "migrate-runtime", false, "")
		port = fs.Int("port", 0, "")
		fs.StringVar(&a.host, "host", envOr("POND_HOST", "127.0.0.1"), "")
		fs.StringVar(&a.image, "image", pondctx.DefaultImage(), "")
		fs.StringVar(&a.minilake, "minilake", os.Getenv("MINILAKE_URL"), "")
		fs.BoolVar(&a.open, "open", false, "")
	case "logs":
		fs.BoolVar(&a.follow, "follow", false, "")
		fs.BoolVar(&a.follow, "f", false, "")
		fs.StringVar(&a.tail, "tail", "200", "")
	case "reset", "import":
		fs.BoolVar(&a.yes, "yes", false, "")
		fs.BoolVar(&a.yes, "y", false, "")
	case "export":
		fs.StringVar(&a.output, "output", "", "")
		fs.StringVar(&a.output, "o", "", "")
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
	if a.command == "import" {
		if len(positional) == 0 {
			return nil, errors.New("import needs a snapshot file")
		}
		a.file, positional = positional[0], positional[1:]
	}
	if len(positional) > 1 {
		return nil, fmt.Errorf("unexpected argument %q", positional[1])
	}
	if len(positional) == 1 {
		a.dir = positional[0]
	}
	if a.command == "up" {
		a.imageExplicit = flagSet(fs, "image") || os.Getenv("POND_MINILAKE_IMAGE") != ""
		envPort := os.Getenv("POND_PORT")
		a.portExplicit = flagSet(fs, "port") || envPort != ""
		a.port = *port
		if flagSet(fs, "port") && (a.port < 1 || a.port > 65535) {
			return nil, fmt.Errorf("--port takes a port from 1 to 65535, got %d", a.port)
		}
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
	if a.minilake != "" && (flagSet(fs, "runtime") || flagSet(fs, "connection") || flagSet(fs, "runtime-socket") || a.migrateRuntime) {
		return nil, errors.New("--minilake attaches to an external service and cannot be combined with managed runtime options")
	}
	if a.minilake != "" {
		a.runtime, a.connection, a.socket = "", "", ""
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
		ln, err := new(net.ListenConfig).Listen(context.Background(), "tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err == nil {
			return ln, nil
		}
		last = err
	}
	tried := make([]string, len(candidates))
	for i, p := range candidates {
		tried[i] = strconv.Itoa(p)
	}
	return nil, fmt.Errorf("No free port for the UI (tried %s): %w", strings.Join(tried, ", "), last)
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

func up(a *args) (result error) {
	var c *pondctx.Context
	fresh := false
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
		// A container left by a killed pond writes its state back when stopped, so
		// stop it before judging whether the lake is fresh.
		if c.Runtime == nil {
			selection, connection, socket := a.runtime, a.connection, a.socket
			if _, err := os.Stat(c.DataPath()); err == nil {
				selection, connection, socket = "", "", ""
			}
			resolved, err := pondctx.ResolveRuntime(context.Background(), selection, connection, socket)
			if err != nil {
				return err
			}
			c.Runtime = resolved
		}
		if err := stopLeftover(*c); err != nil {
			return err
		}
		fresh = pondctx.Fresh(*c)
		if err := pondctx.WriteRunFile(*c, pondctx.RunInfo{PID: os.Getpid()}); err != nil {
			return err
		}
	}

	// SIGTERM (`pond down`) and SIGHUP (a closed terminal) clean up the same way Ctrl-C does.
	sig, stopSignals := signal.NotifyContext(context.Background(), stopSignals...)
	var srv *http.Server
	started := false
	defer func() {
		stopSignals() // a second Ctrl-C during cleanup kills pond
		if srv != nil {
			srv.Close()
		}
		if c != nil {
			if started {
				logf("\nStopping MiniLake…")
				if err := pondctx.Stop(*c); err != nil {
					logf("! Cleanup incomplete: %v", err)
					result = errors.Join(result, err)
				}
			}
			os.Remove(c.RunFile())
		}
	}()

	var url string
	var described *pondctx.Description
	dataRoot := ""
	if c != nil {
		logf("pond · %s  (%s)", c.Name(), c.Dir)
		if c.Runtime != nil && !a.imageExplicit && c.Runtime.Image != "" {
			a.image = c.Runtime.Image
		}
		if err := c.ConfigureRuntime(sig, a.runtime, a.connection, a.socket, a.image, a.migrateRuntime); err != nil {
			return err
		}
		logf("Runtime: %s (%s), connection %s", c.Runtime.Provider, c.Runtime.Kind, c.Runtime.Connection)
		logf("Starting MiniLake…")
		var err error
		started = true
		if url, err = pondctx.Start(sig, *c, a.image, func(s string) { logf("%s", s) }); err != nil {
			if sig.Err() != nil {
				return nil
			}
			return err
		}
		described, dataRoot = c.Describe(), pondctx.DataDir
		pondctx.Remember(*c)
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
	// For UI work: serve web/static from disk, so a reload shows changes without a rebuild.
	if dir := os.Getenv("POND_UI_DIR"); dir != "" {
		static = os.DirFS(dir)
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
	var runtimeInfo any = map[string]string{"kind": "external", "provider": "External MiniLake"}
	var runtimeHealth func(context.Context) error
	if c != nil && c.Runtime != nil {
		runtimeInfo = c.Runtime
		pinned := *c.Runtime
		runtimeHealth = func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			probe := pinned
			return probe.Probe(ctx)
		}
	}
	srv = &http.Server{Handler: server.New(server.Options{
		Host: a.host, AllowedHosts: allowedHosts, Lake: client, Context: ctxInfo, DataRoot: dataRoot,
		Static: static, Version: version, Peers: peers(c), Runtime: runtimeInfo, RuntimeHealth: runtimeHealth,
		ForgetContext: func(dir string) error { return pondctx.Forget(pondctx.ForDir(dir)) },
		Lifecycle:     sig,
	}),
		// Bounds only the request headers; bodies and MCP streams can take as long as they need.
		ReadHeaderTimeout: 10 * time.Second,
	}

	uiPort := port
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		uiPort = addr.Port
	}
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
	// Stop seeding when up returns for any reason, before the deferred cleanup stops MiniLake.
	seedCtx, stopSeeding := context.WithCancel(sig)
	defer stopSeeding()
	switch {
	case c != nil && fresh:
		go func() {
			if err := seedLake(seedCtx, client, *c); err != nil && seedCtx.Err() == nil {
				logf("! %v", err)
				logf("  Fix the script, then run `pond reset` to start over from an empty lake,")
				logf("  or `pond seed` to run every script again if they can safely run twice.")
			}
		}()
	case c != nil && exists(c.SeedMarker()):
		logf("! Seeding didn't finish last time, so this lake may be half seeded. Run `pond reset`")
		logf("  to start over, or `pond seed` if the scripts can safely run twice.")
	case c != nil:
		go func() {
			if err := seed.EnsureArtifacts(seedCtx, seed.NewTarget(client), c.Dir, logf); err != nil && seedCtx.Err() == nil {
				logf("! %v", err)
			}
		}()
	}
	select {
	case <-sig.Done():
		return nil
	case err := <-served:
		return err
	}
}

// peers lists the contexts this pond's UI can open next to its own: running ones and
// recently served ones that are stopped.
func peers(self *pondctx.Context) func() []server.Peer {
	return func() []server.Peer {
		var out []server.Peer
		for _, k := range pondctx.CachedKnownContexts(2 * time.Second) {
			isSelf := self != nil && k.ID == self.ID()
			out = append(out, server.Peer{
				ID: k.ID, Name: k.Name, Dir: k.Dir, Running: k.Running || isSelf, UI: k.UI, Status: k.Status, Self: isSelf,
			})
		}
		// While starting, this context may not be listed yet; it always is to its own UI.
		if self != nil && !slices.ContainsFunc(out, func(p server.Peer) bool { return p.Self }) {
			out = append(out, server.Peer{ID: self.ID(), Name: self.Name(), Dir: self.Dir, Running: true, Self: true})
		}
		// This context first, then running ones, then stopped ones, each by name.
		slices.SortStableFunc(out, func(a, b server.Peer) int {
			rank := func(p server.Peer) int {
				switch {
				case p.Self:
					return 0
				case p.Running:
					return 1
				}
				return 2
			}
			if d := rank(a) - rank(b); d != 0 {
				return d
			}
			return strings.Compare(a.Name, b.Name)
		})
		return out
	}
}

func openBrowser(url string) {
	// The opener hands the URL to the browser and exits; it isn't tied to pond's lifetime.
	ctx := context.Background()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.CommandContext(ctx, "open", url)
	case "windows":
		cmd = exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.CommandContext(ctx, "xdg-open", url)
	}
	if cmd.Start() == nil {
		go func() { _ = cmd.Wait() }()
	}
}

func forget(a *args) error {
	c := pondctx.ForDir(a.dir)
	if err := pondctx.Forget(c); err != nil {
		return err
	}
	logf("Removed %s from the recent-context list. Lake data is kept in %s. Run `%s` to add it again.", c.Name(), c.StateDir(), startCommand(a.dir))
	return nil
}

func ls(all bool) {
	var running []pondctx.Known
	for _, c := range pondctx.KnownContexts() {
		if c.Running || all {
			running = append(running, c)
		}
	}
	if len(running) == 0 {
		if all {
			logf("No known pond contexts.")
		} else {
			logf("No running pond contexts. Use `pond ls --all` to include stopped contexts.")
		}
		return
	}
	rows := [][]string{{"NAME", "UI", "DIR", "STATUS"}}
	for _, r := range running {
		ui := r.UI
		if ui == "" {
			ui = "-"
		}
		status := r.Status
		if !r.Running {
			status = "Stopped"
		} else if status == "" {
			status = "Running"
		}
		rows = append(rows, []string{r.Name, ui, r.Dir, status})
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
	exists, err := pondctx.CheckExists(c)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%s has no MiniLake container. Start it with `%s`", c.Name(), startCommand(a.dir))
	}
	cmd := pondctx.LogsCommand(context.Background(), c, a.follow, a.tail)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Ctrl-C reaches docker directly and ends `logs -f`; pond just waits for it.
	signal.Ignore(os.Interrupt)
	err = cmd.Run()
	if cmd.ProcessState != nil && !cmd.ProcessState.Exited() {
		return nil // stopped by Ctrl-C
	}
	return err
}

func seedContext(a *args) error {
	c, info, err := serving(a.dir)
	if err != nil {
		return err
	}
	if files, err := seed.Files(c.Dir); err != nil || len(files) == 0 {
		if err == nil {
			err = fmt.Errorf("no .sql, .py or .pond.json files in %s", filepath.Join(c.Dir, seed.Dir))
		}
		return err
	}
	client, err := lake.New(info.Minilake)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), stopSignals...)
	defer stop()
	return seedLake(ctx, client, c)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// seedLake runs the context's seeds, leaving a marker until they all succeed.
func seedLake(ctx context.Context, client *lake.Client, c pondctx.Context) error {
	files, err := seed.Files(c.Dir)
	if err != nil || len(files) == 0 {
		return err
	}
	if err := os.WriteFile(c.SeedMarker(), nil, 0o644); err != nil {
		return err
	}
	if err := seed.Run(ctx, seed.NewTarget(client), c.Dir, logf); err != nil {
		return err
	}
	os.Remove(c.SeedMarker())
	return nil
}

// confirm asks the user to type want. It refuses without a terminal to ask on.
func confirm(prompt, want string) error {
	st, err := os.Stdin.Stat()
	null, _ := os.Stat(os.DevNull)
	if err != nil || st.Mode()&os.ModeCharDevice == 0 || os.SameFile(st, null) {
		return errors.New("not a terminal, so not asking for confirmation; pass --yes")
	}
	fmt.Fprintf(os.Stderr, "%s\nType %q to continue: ", prompt, want)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if strings.TrimSpace(line) != want {
		return errors.New("cancelled")
	}
	return nil
}

func reset(a *args) error {
	c := pondctx.ForDir(a.dir)
	if !a.yes {
		if err := confirm(fmt.Sprintf("This deletes every catalog, table, file, job, query and secret in %s.", c.Name()), c.Name()); err != nil {
			return err
		}
	}
	info := pondctx.Serving(c)
	if info == nil {
		// Hold the lock while deleting, so a `pond up` can't start on half-deleted data.
		lock, err := pondctx.Acquire(c)
		if errors.Is(err, pondctx.ErrRunning) {
			return fmt.Errorf("%s just started; run `pond reset` again to reset it while it runs", c.Name())
		}
		if err != nil {
			return err
		}
		defer lock.Release()
		if err := stopLeftover(c); err != nil {
			return err
		}
		if err := pondctx.ClearData(c); err != nil {
			return err
		}
		logf("Deleted the lake data of %s. The next `%s` starts it fresh and runs its seeds.", c.Name(), startCommand(a.dir))
		return nil
	}
	if info.Minilake == "" {
		return fmt.Errorf("%s is still starting; try again in a moment", c.Name())
	}
	client, err := lake.New(info.Minilake)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), stopSignals...)
	defer stop()
	if err := client.Reset(ctx); err != nil {
		return err
	}
	logf("Reset the lake of %s.", c.Name())
	return seedLake(ctx, client, c)
}

// lockStopped takes the context's lock for an offline operation on its data, so a
// `pond up` can't start in the middle of it. It fails when the context is running.
func lockStopped(c pondctx.Context, dir string) (*pondctx.Lock, error) {
	if st, err := os.Stat(c.Dir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", c.Dir)
	}
	lock, err := pondctx.Acquire(c)
	if errors.Is(err, pondctx.ErrRunning) {
		return nil, fmt.Errorf("%s is running. Stop it first with `pond down%s`", c.Name(), strings.TrimPrefix(startCommand(dir), "pond"))
	}
	if err == nil {
		if stopErr := stopLeftover(c); stopErr != nil {
			lock.Release()
			return nil, stopErr
		}
	}
	return lock, err
}

// stopLeftover stops a container left by a pond that was killed, so it can't write its
// state over the data an offline command is about to change.
func stopLeftover(c pondctx.Context) error {
	if _, err := os.Stat(c.StateDir() + "/stopped"); err == nil {
		return nil
	}
	if c.Runtime == nil {
		r, err := pondctx.ResolveRuntime(context.Background(), "", "", "")
		if err != nil {
			return err
		}
		c.Runtime = r
	}
	exists, err := pondctx.CheckExists(c)
	if err != nil {
		return err
	}
	if exists {
		logf("Stopping a MiniLake container left behind by an earlier pond…")
	}
	return pondctx.Stop(c)
}

func export(a *args) error {
	c := pondctx.ForDir(a.dir)
	lock, err := lockStopped(c, a.dir)
	if err != nil {
		return err
	}
	defer lock.Release()
	out := a.output
	if out == "" {
		out = fmt.Sprintf("%s-%s.pond.tar.gz", c.Name(), time.Now().Format("20060102-150405"))
	}
	f, err := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := pondctx.Export(c, f); err != nil {
		f.Close()
		os.Remove(out)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	logf("Exported the lake of %s to %s.", c.Name(), out)
	return nil
}

func importSnapshot(a *args) error {
	c := pondctx.ForDir(a.dir)
	f, err := os.Open(a.file)
	if err != nil {
		return err
	}
	defer f.Close()
	if !pondctx.Fresh(c) && !a.yes {
		if pondctx.Serving(c) == nil {
			if err := confirm(fmt.Sprintf("%s already has lake data. Importing replaces all of it.", c.Name()), c.Name()); err != nil {
				return err
			}
		}
	}
	lock, err := lockStopped(c, a.dir)
	if err != nil {
		return err
	}
	defer lock.Release()
	if err := pondctx.Import(c, f); err != nil {
		return err
	}
	logf("Imported %s into %s. Start it with `%s`.", a.file, c.Name(), startCommand(a.dir))
	return nil
}

// stopSignals end a command the way Ctrl-C does: SIGTERM comes from `pond down`, and
// SIGHUP from closing the terminal pond runs in.
var stopSignals = []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}

// downTimeout bounds how long down waits for a running pond to stop.
const downTimeout = time.Minute

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
		// Wait for the lock, so a command run straight after (reset, import, up)
		// doesn't find the context half shut down.
		logf("Stopping %s (pid %d)…", c.Name(), info.PID)
		for deadline := time.Now().Add(downTimeout); pondctx.Serving(c) != nil; {
			if time.Now().After(deadline) {
				return fmt.Errorf("%s is still stopping after %s; check pid %d", c.Name(), downTimeout, info.PID)
			}
			time.Sleep(200 * time.Millisecond)
		}
		if err := pondctx.Stop(c); err != nil {
			return fmt.Errorf("context stopped, but cleanup is incomplete: %w", err)
		}
		logf("Stopped %s.", c.Name())
		return nil
	}
	os.Remove(c.RunFile())
	if err := stopLeftover(c); err != nil {
		return err
	}
	logf("Stopped %s. Data in %s is kept.", c.Name(), c.StateDir())
	return nil
}
