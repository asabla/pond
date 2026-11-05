package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGraphCLIParsing(t *testing.T) {
	valid := [][]string{
		{"list"}, {"show", "Messaging", "--url", "http://localhost:8700"},
		{"metrics", "Messaging", "pagerank", "--top", "5", "--json"},
		{"metrics", "pagerank", "--definition", "graph.json"},
		{"stats", "--definition", "graph.json"},
		{"save", "Messaging", "--edges-table", "a.b.c", "--source", "s", "--target", "t"},
		{"save", "Messaging", "--edges-sql-file", "edges.sql", "--nodes-sql-file", "nodes.sql"},
		{"path", "Messaging", "--from", "0", "--to", "25", "--unweighted"},
	}
	for _, argv := range valid {
		if _, err := parse(append([]string{"graph"}, argv...)); err != nil {
			t.Errorf("%v: %v", argv, err)
		}
	}
	invalid := [][]string{
		{"list", "extra"}, {"stats"}, {"stats", "x", "--definition", "g.json"},
		{"list", "--dir", ".", "--url", "http://localhost:8700"}, {"list", "--url", "file:///tmp"},
		{"path", "x", "--from", "a"}, {"metrics", "x", "degree", "--top", "101"},
		{"save", "x", "--edges-table", "a", "--source", "s"},
		{"save", "x", "--definition", "x.json", "--edges-sql-file", "x.sql"},
		{"save", "x", "--edges-sql-file", "x.sql", "--nodes-table", "nodes"},
		{"save", "x", "--definition", "x.json", "--undirected"}, {"stats", "x", "--scope", "partial"},
		{"stats", "x", "--timeout", "0"},
	}
	for _, argv := range invalid {
		if _, err := parseGraph(argv); err == nil {
			t.Errorf("accepted %v", argv)
		}
	}
	if _, err := parseGraph([]string{"--help"}); !errors.Is(err, errGraphHelp) {
		t.Fatalf("help: %v", err)
	}
}

func TestGraphCLIInputAndJSON(t *testing.T) {
	g := &graphArgs{command: "save", name: "Messaging", edgesTable: "demo.social.messages", source: "sender", target: "recipient", weight: "weight", nodesTable: "demo.social.people", nodeID: "id", label: "name"}
	def, err := g.readDefinition(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(def.EdgesSQL, `"sender" AS source`) || !strings.Contains(def.NodesSQL, `"name" AS label`) || !def.Directed {
		t.Fatalf("mapping: %+v", def)
	}
	file := filepath.Join(t.TempDir(), "graph.json")
	if err := os.WriteFile(file, []byte(`{"edges_sql":"SELECT 1,2"}`), 0600); err != nil {
		t.Fatal(err)
	}
	g = &graphArgs{definition: file}
	def, err = g.readDefinition(context.Background())
	if err != nil || !def.Directed {
		t.Fatalf("direction: %+v %v", def, err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pond/graph/path" {
			t.Errorf("path: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["from"] != "a" || body["to"] != "b" {
			t.Errorf("body: %v", body)
		}
		_, _ = w.Write([]byte(`{"graph":"x","scope":"full","result":null}`))
	}))
	defer srv.Close()
	var out bytes.Buffer
	g = &graphArgs{command: "path", name: "x", from: "a", to: "b", scope: "full", serverURL: srv.URL, json: true, timeout: 1000000000}
	if err := graphCommand(g, &out); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || result["result"] != nil {
		t.Fatalf("no path JSON: %s %v", out.String(), err)
	}
	out.Reset()
	g.json = false
	if err := graphCommand(g, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "none") || !strings.Contains(out.String(), "full") {
		t.Fatalf("text: %s", out.String())
	}
}

func TestGraphCLIStoppedContext(t *testing.T) {
	g := &graphArgs{command: "list", dir: t.TempDir(), timeout: 1000000000}
	var out bytes.Buffer
	err := graphCommand(g, &out)
	if err == nil || !strings.Contains(err.Error(), "Start it with") || out.Len() != 0 {
		t.Fatalf("stopped context: %v %s", err, out.String())
	}
}
