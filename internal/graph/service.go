package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/asabla/pond/internal/lake"
	"github.com/dop251/goja"
)

const (
	// MaxEdges is the source edge row limit for complete analysis.
	MaxEdges = 30000
	// MaxNodes includes isolated nodes supplied by the node query.
	MaxNodes = 60000
	// MaxBytes bounds decoded graph rows in one analysis.
	MaxBytes = 32 << 20
	// Timeout is the default request timeout.
	Timeout   = 60 * time.Second
	graphsDir = "/pond/graphs"
)

// Definition is the graph format shared with the browser.
type Definition struct {
	Name     string `json:"name,omitempty"`
	EdgesSQL string `json:"edges_sql"`
	NodesSQL string `json:"nodes_sql,omitempty"`
	Directed bool   `json:"directed"`
}

// UnmarshalJSON makes omitted direction mean directed, as in the browser.
func (d *Definition) UnmarshalJSON(data []byte) error {
	type plain Definition
	v := plain{Directed: true}
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*d = Definition(v)
	return nil
}

// Request identifies a graph and an analysis without browser state.
type Request struct {
	Name       string      `json:"name,omitempty"`
	Definition *Definition `json:"definition,omitempty"`
	Scope      string      `json:"scope,omitempty"`
	Metric     string      `json:"metric,omitempty"`
	Top        int         `json:"top,omitempty"`
	Node       string      `json:"node,omitempty"`
	From       string      `json:"from,omitempty"`
	To         string      `json:"to,omitempty"`
	Unweighted bool        `json:"unweighted,omitempty"`
}

// Saved includes a definition and a browser route relative to the Pond server.
type Saved struct {
	Definition Definition `json:"definition"`
	URL        string     `json:"url"`
}

// Service owns the per-context analysis queue and saved graph writes.
type Service struct {
	lake   *lake.Client
	gate   chan struct{}
	saveMu sync.Mutex
}

// New returns a service for one Pond context.
func New(client *lake.Client) *Service { return &Service{lake: client, gate: make(chan struct{}, 1)} }

type savedFile struct {
	path string
	def  Definition
}

func (s *Service) files(ctx context.Context) ([]savedFile, []lake.FileEntry, error) {
	entries, err := s.lake.ListDir(ctx, graphsDir)
	var le *lake.Error
	if errors.As(err, &le) && le.Status == http.StatusNotFound {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var files []savedFile
	for _, entry := range entries {
		if entry.IsDirectory || !strings.HasSuffix(entry.Path, ".json") || path.Dir(entry.Path) != graphsDir {
			continue
		}
		data, err := s.lake.ReadFile(ctx, entry.Path, 1<<20)
		if err != nil {
			return nil, nil, err
		}
		var def Definition
		if json.Unmarshal(data, &def) != nil || def.Name == "" || strings.TrimSpace(def.EdgesSQL) == "" {
			continue
		}
		files = append(files, savedFile{entry.Path, def})
	}
	return files, entries, nil
}

// List returns saved definitions in name order.
func (s *Service) List(ctx context.Context) ([]Definition, error) {
	files, _, err := s.files(ctx)
	if err != nil {
		return nil, err
	}
	defs := make([]Definition, 0, len(files))
	for _, f := range files {
		defs = append(defs, f.def)
	}
	sort.Slice(defs, func(i, j int) bool { return defs[i].Name < defs[j].Name })
	return defs, nil
}

// Get finds a saved graph by its exact name.
func (s *Service) Get(ctx context.Context, name string) (*Saved, error) {
	defs, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, def := range defs {
		if def.Name == name {
			return &Saved{def, "/#/graph/" + url.PathEscape(name)}, nil
		}
	}
	return nil, fmt.Errorf("no saved graph named %q", name)
}

// Save creates a definition. Replacing one requires explicit permission.
func (s *Service) Save(ctx context.Context, def Definition, replace bool) (*Saved, error) {
	e, err := newEngine(ctx)
	if err != nil {
		return nil, err
	}
	defer e.close()
	problem, err := e.call("validateDefinition", def)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(def.Name) == "" {
		return nil, fmt.Errorf("a saved graph needs a name")
	}
	if !goja.IsNull(problem) {
		return nil, fmt.Errorf("invalid graph definition: %s", problem)
	}
	v, err := e.call("normalize", def)
	if err != nil {
		return nil, err
	}
	if err := e.export(v, &def); err != nil {
		return nil, err
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	files, entries, err := s.files(ctx)
	if err != nil {
		return nil, err
	}
	file := ""
	for _, f := range files {
		if f.def.Name == def.Name {
			if !replace {
				return nil, fmt.Errorf("graph %q already exists; use replace to overwrite it", def.Name)
			}
			file = f.path
		}
	}
	overwrite := file != ""
	if file == "" {
		base, err := e.sql("fileBase", def.Name)
		if err != nil {
			return nil, err
		}
		used := map[string]bool{}
		for _, entry := range entries {
			used[entry.Path] = true
		}
		for i := 1; ; i++ {
			file = graphsDir + "/" + base
			if i > 1 {
				file += fmt.Sprintf("-%d", i)
			}
			file += ".json"
			if !used[file] {
				break
			}
		}
	}
	data, err := json.MarshalIndent(def, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := s.lake.WriteFile(ctx, file, data, overwrite); err != nil {
		return nil, err
	}
	return &Saved{def, "/#/graph/" + url.PathEscape(def.Name)}, nil
}

func (s *Service) resolve(ctx context.Context, req Request) (Definition, error) {
	if (req.Name == "") == (req.Definition == nil) {
		return Definition{}, fmt.Errorf("give either name or definition")
	}
	if req.Definition != nil {
		return *req.Definition, nil
	}
	saved, err := s.Get(ctx, req.Name)
	if err != nil {
		return Definition{}, err
	}
	return saved.Definition, nil
}

// FromTables applies the same table-to-SQL mapping used by the browser.
func FromTables(ctx context.Context, options map[string]any) (*Definition, error) {
	e, err := newEngine(ctx)
	if err != nil {
		return nil, err
	}
	defer e.close()
	v, err := e.call("definitionFromTables", options)
	if err != nil {
		return nil, err
	}
	var def Definition
	if err := e.export(v, &def); err != nil {
		return nil, err
	}
	return &def, nil
}

// Analyze runs an operation on current lake data. Queue time counts toward its timeout.
func (s *Service) Analyze(ctx context.Context, operation string, req Request) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	if req.Scope == "" {
		req.Scope = "full"
	}
	if req.Scope != "full" && req.Scope != "overview" {
		return nil, fmt.Errorf("scope must be full or overview")
	}
	if req.Top == 0 {
		req.Top = 10
	}
	if req.Top < 1 || req.Top > 100 {
		return nil, fmt.Errorf("top must be between 1 and 100")
	}
	select {
	case s.gate <- struct{}{}:
		defer func() { <-s.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	def, err := s.resolve(ctx, req)
	if err != nil {
		return nil, err
	}
	e, err := newEngine(ctx)
	if err != nil {
		return nil, err
	}
	defer e.close()
	problem, err := e.call("validateDefinition", def)
	if err != nil {
		return nil, err
	}
	if !goja.IsNull(problem) {
		return nil, fmt.Errorf("invalid graph definition: %s", problem)
	}
	normalized, err := e.call("normalize", def)
	if err != nil {
		return nil, err
	}
	if err := e.export(normalized, &def); err != nil {
		return nil, err
	}
	loaded, err := s.load(ctx, e, def, req.Scope, operation == "path" && req.Unweighted)
	if err != nil {
		return nil, err
	}
	limits := map[string]int{"edge_rows": MaxEdges, "nodes": MaxNodes, "row_bytes": MaxBytes}
	meta := map[string]any{"graph": def.Name, "scope": loaded.scope, "nodes": 0, "edges": 0, "directed": def.Directed, "weighted": loaded.weighted, "total_edge_rows": loaded.total, "loaded_edge_rows": loaded.rows, "limits": limits}
	if loaded.g != nil {
		st, err := e.call("stats", loaded.g, e.vm.Get("graphologyLibrary"), loaded.weighted)
		if err != nil {
			return nil, err
		}
		if err := e.export(st, &meta); err != nil {
			return nil, err
		}
	}
	var result goja.Value
	switch operation {
	case "stats":
		return meta, nil
	case "metrics":
		result, err = e.call("ranking", loaded.g, e.vm.Get("graphologyLibrary"), req.Metric, loaded.weighted, req.Top)
	case "neighbors":
		if req.Node == "" {
			return nil, fmt.Errorf("node is required")
		}
		result, err = e.call("neighbors", loaded.g, req.Node)
	case "path":
		if req.From == "" || req.To == "" {
			return nil, fmt.Errorf("from and to are required")
		}
		if loaded.scope != "full" {
			if !req.Unweighted {
				return nil, fmt.Errorf("paths outside a complete load require explicit unweighted search")
			}
			p, pathErr := s.sqlPath(ctx, e, def, loaded.columns, req.From, req.To)
			if pathErr != nil {
				return nil, pathErr
			}
			meta["scope"], meta["result"] = "full_sql", p
			limits["path_hops"] = 20
			limits["path_frontier"] = 20000
			return meta, nil
		}
		result, err = e.call("shortestPath", loaded.g, e.vm.Get("graphologyLibrary"), req.From, req.To, loaded.weighted && !req.Unweighted)
	default:
		return nil, fmt.Errorf("unknown graph operation %q", operation)
	}
	if err != nil {
		return nil, err
	}
	var value any
	if err := e.export(result, &value); err != nil {
		return nil, err
	}
	meta["result"] = value
	return meta, nil
}
