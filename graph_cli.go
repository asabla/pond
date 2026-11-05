package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/asabla/pond/internal/graph"
)

const graphUsage = `Graph commands (a running Pond is required):
  pond graph list
  pond graph show NAME
  pond graph save NAME --edges-table TABLE --source COLUMN --target COLUMN [options]
  pond graph save NAME --edges-sql-file FILE [--nodes-sql-file FILE] [--undirected]
  pond graph save NAME --definition FILE [--replace]
  pond graph stats NAME [--scope full|overview]
  pond graph metrics NAME METRIC [--top 10] [--scope full|overview]
  pond graph neighbors NAME --node ID [--scope full|overview]
  pond graph path NAME --from ID --to ID [--unweighted]
  pond graph open NAME

Common flags: --dir PATH or --url URL, --json, --timeout 60s.
Analysis accepts --definition FILE instead of NAME. Metrics still need METRIC.
Table options: --weight COLUMN, --nodes-table TABLE --node-id COLUMN [--label COLUMN].
Save is directed by default. Use --undirected to change it. Replacement requires --replace.
Metrics: degree, in_degree, out_degree, pagerank, betweenness, closeness, eigenvector,
hub, authority, clustering, community, component, strong_component, attr:COLUMN.
`

var errGraphHelp = errors.New("graph help requested")

type graphArgs struct {
	command, name, metric, dir, serverURL, definition             string
	scope, node, from, to                                         string
	edgesTable, source, target, weight, nodesTable, nodeID, label string
	edgesFile, nodesFile                                          string
	json, replace, undirected, unweighted                         bool
	top                                                           int
	timeout                                                       time.Duration
}

func parseGraph(argv []string) (*args, error) {
	if len(argv) == 0 || argv[0] == "--help" || argv[0] == "-h" {
		return nil, errGraphHelp
	}
	g := &graphArgs{command: argv[0]}
	fs := flag.NewFlagSet("graph "+g.command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&g.dir, "dir", ".", "")
	fs.StringVar(&g.serverURL, "url", "", "")
	fs.BoolVar(&g.json, "json", false, "")
	fs.DurationVar(&g.timeout, "timeout", graph.Timeout, "")
	switch g.command {
	case "list", "show", "open":
	case "save":
		fs.StringVar(&g.definition, "definition", "", "")
		fs.BoolVar(&g.replace, "replace", false, "")
		fs.BoolVar(&g.undirected, "undirected", false, "")
		for name, ptr := range map[string]*string{"edges-table": &g.edgesTable, "source": &g.source, "target": &g.target, "weight": &g.weight, "nodes-table": &g.nodesTable, "node-id": &g.nodeID, "label": &g.label, "edges-sql-file": &g.edgesFile, "nodes-sql-file": &g.nodesFile} {
			fs.StringVar(ptr, name, "", "")
		}
	case "stats", "metrics", "neighbors", "path":
		fs.StringVar(&g.definition, "definition", "", "")
		fs.StringVar(&g.scope, "scope", "full", "")
		if g.command == "metrics" {
			fs.IntVar(&g.top, "top", 10, "")
		}
		if g.command == "neighbors" {
			fs.StringVar(&g.node, "node", "", "")
		}
		if g.command == "path" {
			fs.StringVar(&g.from, "from", "", "")
			fs.StringVar(&g.to, "to", "", "")
			fs.BoolVar(&g.unweighted, "unweighted", false, "")
		}
	default:
		return nil, fmt.Errorf("unknown graph command %q\n%s", g.command, graphUsage)
	}
	var positional []string
	for rest := argv[1:]; ; {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, errGraphHelp
			}
			return nil, err
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	if g.timeout <= 0 {
		return nil, errors.New("--timeout must be positive")
	}
	if g.serverURL != "" && flagSet(fs, "dir") {
		return nil, errors.New("--dir and --url cannot be combined")
	}
	if g.serverURL != "" {
		u, err := url.Parse(g.serverURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || (u.Path != "" && u.Path != "/") {
			return nil, errors.New("--url must be a Pond server URL, such as http://localhost:8700")
		}
		g.serverURL = strings.TrimRight(g.serverURL, "/")
	}
	if g.scope != "" && g.scope != "full" && g.scope != "overview" {
		return nil, errors.New("--scope must be full or overview")
	}
	want := 1
	if g.command == "list" {
		want = 0
	}
	if g.definition != "" && g.command != "save" {
		want--
	}
	if g.command == "metrics" {
		want++
	}
	if len(positional) != want {
		return nil, fmt.Errorf("invalid arguments for graph %s\n%s", g.command, graphUsage)
	}
	if want > 0 {
		if g.definition == "" || g.command == "save" {
			g.name = positional[0]
		}
		if g.command == "metrics" {
			g.metric = positional[len(positional)-1]
		}
	}
	if g.command == "neighbors" && g.node == "" {
		return nil, errors.New("--node is required")
	}
	if g.command == "path" && (g.from == "" || g.to == "") {
		return nil, errors.New("--from and --to are required")
	}
	if g.command == "metrics" && (g.top < 1 || g.top > 100) {
		return nil, errors.New("--top must be between 1 and 100")
	}
	if g.command == "save" {
		table := g.edgesTable != "" || g.source != "" || g.target != "" || g.weight != "" || g.nodesTable != "" || g.nodeID != "" || g.label != ""
		inputs := 0
		if table {
			inputs++
		}
		if g.edgesFile != "" || g.nodesFile != "" {
			inputs++
		}
		if g.definition != "" {
			inputs++
		}
		if inputs != 1 {
			return nil, errors.New("choose one graph input: table options, SQL files, or --definition")
		}
		if table && (g.edgesTable == "" || g.source == "" || g.target == "") {
			return nil, errors.New("table input needs --edges-table, --source and --target")
		}
		if (g.nodesTable == "") != (g.nodeID == "") || g.label != "" && g.nodesTable == "" {
			return nil, errors.New("node options need --nodes-table and --node-id")
		}
		if g.nodesFile != "" && g.edgesFile == "" {
			return nil, errors.New("--nodes-sql-file requires --edges-sql-file")
		}
		if g.definition != "" && flagSet(fs, "undirected") {
			return nil, errors.New("--definition supplies its own direction")
		}
	}
	return &args{command: "graph", graph: g}, nil
}

func (g *graphArgs) readDefinition(ctx context.Context) (*graph.Definition, error) {
	if g.definition != "" {
		body, err := os.ReadFile(g.definition)
		if err != nil {
			return nil, err
		}
		var def graph.Definition
		if err := json.Unmarshal(body, &def); err != nil {
			return nil, err
		}
		return &def, nil
	}
	if g.command != "save" {
		return nil, nil
	}
	d := &graph.Definition{Name: g.name, Directed: !g.undirected}
	if g.edgesFile != "" {
		body, err := os.ReadFile(g.edgesFile)
		if err != nil {
			return nil, err
		}
		d.EdgesSQL = string(body)
		if g.nodesFile != "" {
			body, err = os.ReadFile(g.nodesFile)
			if err != nil {
				return nil, err
			}
			d.NodesSQL = string(body)
		}
		return d, nil
	}
	return graph.FromTables(ctx, map[string]any{
		"name": g.name, "edgeTable": g.edgesTable, "source": g.source, "target": g.target,
		"weight": g.weight, "nodeTable": g.nodesTable, "nodeId": g.nodeID, "label": g.label, "directed": !g.undirected,
	})
}

func graphCommand(g *graphArgs, out io.Writer) error {
	ctx, stop := signal.NotifyContext(context.Background(), stopSignals...)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	base := g.serverURL
	if base == "" {
		_, info, err := serving(g.dir)
		if err != nil {
			return err
		}
		base = info.UI
	}
	def, err := g.readDefinition(ctx)
	if err != nil {
		return err
	}
	method, endpoint := http.MethodGet, "/pond/graphs"
	var payload any
	switch g.command {
	case "show", "open":
		endpoint += "/" + url.PathEscape(g.name)
	case "save":
		def.Name = g.name
		method, endpoint = http.MethodPut, endpoint+"/"+url.PathEscape(g.name)
		payload = map[string]any{"definition": def, "replace": g.replace}
	case "stats", "metrics", "neighbors", "path":
		method, endpoint = http.MethodPost, "/pond/graph/"+g.command
		payload = graph.Request{Name: g.name, Definition: def, Scope: g.scope, Metric: g.metric, Top: g.top, Node: g.node, From: g.from, To: g.to, Unweighted: g.unweighted}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, base+endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("Pond returned an invalid graph response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%v", result["message"])
	}
	if route, ok := result["url"].(string); ok {
		result["url"] = base + route
	}
	if g.command == "open" {
		browserURL, ok := result["url"].(string)
		if !ok || browserURL == "" {
			return errors.New("Pond did not return a graph URL")
		}
		openBrowser(browserURL)
	}
	if g.json {
		enc := json.NewEncoder(out)
		return enc.Encode(result)
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	printGraphValue(w, result, "")
	return w.Flush()
}

func printGraphValue(w io.Writer, value any, prefix string) {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			printGraphValue(w, v[key], prefix+key+".")
		}
	case []any:
		if len(v) == 0 {
			fmt.Fprintf(w, "%s\t(empty)\n", strings.TrimSuffix(prefix, "."))
		}
		for i, item := range v {
			printGraphValue(w, item, fmt.Sprintf("%s%d.", prefix, i+1))
		}
	default:
		text := fmt.Sprint(v)
		if v == nil {
			text = "none"
		}
		fmt.Fprintf(w, "%s\t%s\n", strings.TrimSuffix(prefix, "."), text)
	}
}
