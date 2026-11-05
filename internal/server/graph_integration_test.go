package server

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This opt-in check runs against an isolated Pond seeded with examples/social.
func TestLiveGraphAcceptance(t *testing.T) {
	endpoint := os.Getenv("POND_GRAPH_ACCEPTANCE_URL")
	if endpoint == "" {
		t.Skip("set POND_GRAPH_ACCEPTANCE_URL to a disposable, seeded Pond context")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	session := connectMCP(ctx, t, endpoint, nil)
	foundGraph, foundSQL := false, false
	var nativeSQL *mcp.Tool
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		foundGraph = foundGraph || tool.Name == "pond_graph_metrics"
		foundSQL = foundSQL || tool.Name == "run_sql"
		if tool.Name == "run_sql" {
			nativeSQL = tool
		}
	}
	if !foundGraph || !foundSQL {
		t.Fatal("combined discovery is incomplete")
	}
	call := func(name string, args map[string]any) (*mcp.CallToolResult, map[string]any) {
		t.Helper()
		res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		body, _ := json.Marshal(res.StructuredContent)
		_ = json.Unmarshal(body, &result)
		if res.IsError {
			detail, _ := json.Marshal(res)
			t.Logf("%s: %s", name, detail)
		}
		return res, result
	}
	for _, metric := range []string{"degree", "in_degree", "out_degree", "pagerank", "betweenness", "closeness", "eigenvector", "hub", "authority", "clustering", "community", "component", "strong_component"} {
		res, result := call("pond_graph_metrics", map[string]any{"name": "Messaging", "metric": metric})
		if res.IsError || result["nodes"] != float64(300) || result["scope"] != "full" {
			t.Fatalf("%s: %+v %+v", metric, res, result)
		}
	}
	// Use the discovered MiniLake schema; keep this check valid across SQL parameter names.
	var sqlSchema struct {
		Properties map[string]any `json:"properties"`
	}
	schemaJSON, _ := json.Marshal(nativeSQL.InputSchema)
	if err := json.Unmarshal(schemaJSON, &sqlSchema); err != nil {
		t.Fatal(err)
	}
	sqlArgs := map[string]any{}
	for _, key := range []string{"sql", "statement", "query"} {
		if _, ok := sqlSchema.Properties[key]; ok {
			sqlArgs[key] = "SELECT 1 AS n"
			break
		}
	}
	if len(sqlArgs) == 0 {
		t.Fatalf("unknown upstream SQL schema: %s", schemaJSON)
	}
	nativeResult, _ := call("run_sql", sqlArgs)
	if nativeResult.IsError {
		t.Fatal("native MiniLake SQL failed through the combined endpoint")
	}
	large := map[string]any{"edges_sql": "SELECT i AS source, i+1 AS target FROM range(40001) t(i)", "directed": true}
	res, _ := call("pond_graph_stats", map[string]any{"definition": large})
	if !res.IsError {
		t.Fatal("large graph silently sampled")
	}
	res, result := call("pond_graph_stats", map[string]any{"definition": large, "scope": "overview"})
	if res.IsError || result["scope"] != "overview" {
		t.Fatalf("overview: %+v %+v", res, result)
	}
	res, result = call("pond_graph_path", map[string]any{"definition": large, "from": "0", "to": "5", "unweighted": true})
	if res.IsError || result["scope"] != "full_sql" || result["result"].(map[string]any)["hops"] != float64(5) {
		t.Fatalf("SQL path: %+v %+v", res, result)
	}
	res, result = call("pond_graph_path", map[string]any{"definition": large, "from": "40001", "to": "0", "unweighted": true})
	if res.IsError || result["result"] != nil {
		t.Fatalf("SQL no path: %+v %+v", res, result)
	}
	res, _ = call("pond_graph_path", map[string]any{"definition": large, "from": "0", "to": "22", "unweighted": true})
	if !res.IsError {
		t.Fatal("path limit reported as no path")
	}
}
