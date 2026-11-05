package graph

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/asabla/pond/internal/lake"
)

type fakeGraphLake struct {
	mu        sync.Mutex
	files     map[string][]byte
	total     int
	truncated bool
	listError bool
}

func graphFixture(t *testing.T) (*Service, *fakeGraphLake) {
	t.Helper()
	f := &fakeGraphLake{files: map[string][]byte{}, total: 4}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	c, err := lake.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return New(c), f
}

func (f *fakeGraphLake) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/2.0/fs/directories/"):
		if f.listError {
			http.Error(w, "backend failure", http.StatusInternalServerError)
			return
		}
		entries := []lake.FileEntry{}
		for path := range f.files {
			entries = append(entries, lake.FileEntry{Path: path})
		}
		write(map[string]any{"contents": entries})
	case strings.HasPrefix(p, "/api/2.0/fs/files/"):
		path := "/" + strings.TrimPrefix(p, "/api/2.0/fs/files/")
		if r.Method == http.MethodPut {
			if _, exists := f.files[path]; exists && r.URL.Query().Get("overwrite") != "true" {
				http.Error(w, "already exists", http.StatusConflict)
				return
			}
			var data json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			f.files[path] = data
			write(map[string]any{})
			return
		}
		data, exists := f.files[path]
		if !exists {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	case p == "/api/2.0/sql/warehouses":
		write(map[string]any{"warehouses": []map[string]string{{"id": "w"}}})
	case p == "/api/2.0/sql/statements":
		var req struct{ Statement string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		columns := []map[string]string{{"name": "source", "type_text": "VARCHAR"}, {"name": "target", "type_text": "VARCHAR"}, {"name": "weight", "type_text": "DOUBLE"}}
		rows := [][]any{{"a", "b", 2}, {"a", "b", 3}, {"b", "c", 1}, {"c", "a", 1}}
		if strings.Contains(req.Statement, "count(*) AS edges") {
			columns = []map[string]string{{"name": "edges", "type_text": "BIGINT"}}
			rows = [][]any{{f.total}}
		}
		if strings.Contains(req.Statement, "AS n") {
			columns = []map[string]string{{"name": "id", "type_text": "VARCHAR"}, {"name": "label", "type_text": "VARCHAR"}}
			rows = [][]any{{"a", "Ann"}, {"b", "Bob"}, {"c", "Cyd"}, {"isolated", "Dee"}}
		}
		if strings.Contains(req.Statement, "LIMIT 0") {
			rows = [][]any{}
		}
		write(map[string]any{"statement_id": "s", "status": map[string]string{"state": "SUCCEEDED"}, "manifest": map[string]any{"schema": map[string]any{"columns": columns}, "truncated": f.truncated}, "result": map[string]any{"data_array": rows}})
	default:
		http.NotFound(w, r)
	}
}

func TestGraphServiceDefinitionsAndAnalysis(t *testing.T) {
	s, f := graphFixture(t)
	ctx := context.Background()
	d := Definition{Name: "a b", EdgesSQL: "SELECT * FROM edges;", NodesSQL: "SELECT * FROM nodes;", Directed: true}
	if _, err := s.Save(ctx, d, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(ctx, d, false); err == nil {
		t.Fatal("overwrite accepted without replace")
	}
	if _, err := s.Save(ctx, d, true); err != nil {
		t.Fatal(err)
	}
	d.Name = "a_b"
	if _, err := s.Save(ctx, d, false); err != nil {
		t.Fatal(err)
	}
	if len(f.files) != 2 {
		t.Fatal("filename collision lost a definition")
	}
	if _, err := s.Get(ctx, "missing"); err == nil {
		t.Fatal("missing name accepted")
	}
	stats, err := s.Analyze(ctx, "stats", Request{Name: "a b"})
	if err != nil {
		t.Fatal(err)
	}
	if stats["nodes"] != float64(4) || stats["edges"] != float64(3) || stats["total_edge_rows"] != 4 {
		t.Fatalf("stats: %v", stats)
	}
	for _, operation := range []string{"metrics", "neighbors", "path"} {
		result, err := s.Analyze(ctx, operation, Request{Definition: &d, Metric: "pagerank", Node: "a", From: "a", To: "c"})
		if err != nil {
			t.Fatalf("%s: %v", operation, err)
		}
		if result["result"] == nil {
			t.Fatalf("%s: empty result", operation)
		}
	}
	result, err := s.Analyze(ctx, "path", Request{Definition: &d, From: "a", To: "isolated"})
	if err != nil || result["result"] != nil {
		t.Fatalf("no path: %v %v", result, err)
	}
	if _, err := s.Analyze(ctx, "neighbors", Request{Name: "a b", Node: "Ann"}); err == nil {
		t.Fatal("label accepted instead of exact id")
	}
	f.truncated = true
	if _, err := s.Analyze(ctx, "stats", Request{Name: "a b"}); err == nil {
		t.Fatal("truncated query accepted")
	}
}

func TestFullGraphLimitAndCancelledQueue(t *testing.T) {
	s, f := graphFixture(t)
	f.total = MaxEdges + 1
	d := Definition{EdgesSQL: "SELECT * FROM edges", Directed: true}
	if _, err := s.Analyze(context.Background(), "stats", Request{Definition: &d}); err == nil || !strings.Contains(err.Error(), "overview") {
		t.Fatalf("large graph: %v", err)
	}
	s.gate <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Analyze(ctx, "stats", Request{Definition: &d}); !errors.Is(err, context.Canceled) {
		t.Fatalf("queue: %v", err)
	}
	<-s.gate
	f.listError = true
	if _, err := s.List(context.Background()); err == nil {
		t.Fatal("backend failure reported as empty directory")
	}
}
