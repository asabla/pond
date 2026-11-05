package seed

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/asabla/pond/internal/graph"
	"github.com/asabla/pond/internal/lake"
)

// This opt-in test needs a fresh, disposable MiniLake 1.9.1 instance.
func TestLiveExampleSeeds(t *testing.T) {
	endpoint := os.Getenv("POND_SEED_ACCEPTANCE_URL")
	if endpoint == "" {
		t.Skip("set POND_SEED_ACCEPTANCE_URL to a disposable MiniLake")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, err := lake.New(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	target := NewTarget(client)
	for _, example := range []string{"social", "shop"} {
		dir := "../../examples/" + example
		if err := Run(ctx, target, dir, t.Logf); err != nil {
			t.Fatal(err)
		}
		if err := EnsureArtifacts(ctx, target, dir, t.Logf); err != nil {
			t.Fatal(err)
		}
	}
	graphs := graph.New(client)
	definitions, err := graphs.List(ctx)
	if err != nil || len(definitions) != 4 {
		t.Fatalf("saved graphs: %v %v", definitions, err)
	}
	for _, def := range definitions {
		result, err := graphs.Analyze(ctx, "stats", graph.Request{Name: def.Name})
		if err != nil {
			t.Fatalf("%s: %v", def.Name, err)
		}
		if result["nodes"].(float64) == 0 || result["edges"].(float64) == 0 {
			t.Fatalf("empty graph %s: %v", def.Name, result)
		}
		t.Logf("%s: %v nodes, %v edges", def.Name, result["nodes"], result["edges"])
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/api/2.0/sql/queries", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var saved struct {
		Results []struct {
			Name string `json:"display_name"`
			SQL  string `json:"query_text"`
		}
	}
	if err := json.NewDecoder(response.Body).Decode(&saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Results) != 4 {
		t.Fatalf("saved queries: %v", saved.Results)
	}
	for _, query := range saved.Results {
		if _, err := client.QuerySQL(ctx, query.SQL, 30000, 32<<20); err != nil {
			t.Fatalf("query %s: %v", query.Name, err)
		}
	}
}
