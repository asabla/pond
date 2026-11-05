package seed

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/asabla/pond/internal/graph"
	"github.com/asabla/pond/internal/lake"
)

func TestArtifactTargetPreservesEditsAndAvoidsDuplicates(t *testing.T) {
	queries := map[string]string{"Existing": "SELECT 'user query'"}
	files := map[string][]byte{"/pond/graphs/Existing.json": []byte(`{"name":"Existing","edges_sql":"SELECT 1,3","directed":false}`)}
	writes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		write := func(value any) { _ = json.NewEncoder(w).Encode(value) }
		switch {
		case r.URL.Path == "/api/2.0/sql/warehouses":
			write(map[string]any{"warehouses": []map[string]string{{"id": "w"}}})
		case r.URL.Path == "/api/2.0/sql/queries" && r.Method == http.MethodGet:
			rows := []map[string]string{}
			for name, sql := range queries {
				rows = append(rows, map[string]string{"display_name": name, "query_text": sql})
			}
			write(map[string]any{"results": rows})
		case r.URL.Path == "/api/2.0/sql/queries" && r.Method == http.MethodPost:
			var body struct {
				Query struct {
					Name string `json:"display_name"`
					SQL  string `json:"query_text"`
				}
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			queries[body.Query.Name] = body.Query.SQL
			writes++
			write(map[string]string{"id": "new"})
		case strings.HasPrefix(r.URL.Path, "/api/2.0/fs/directories/"):
			entries := []map[string]any{}
			for file := range files {
				entries = append(entries, map[string]any{"path": file, "is_directory": false})
			}
			write(map[string]any{"contents": entries})
		case strings.HasPrefix(r.URL.Path, "/api/2.0/fs/files/"):
			file := "/" + strings.TrimPrefix(r.URL.Path, "/api/2.0/fs/files/")
			if r.Method == http.MethodPut {
				if r.URL.Query().Get("overwrite") != "false" {
					t.Error("artifact seeding attempted overwrite")
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				files[file] = body
				writes++
				write(map[string]any{})
				return
			}
			_, _ = w.Write(files[file])
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client, err := lake.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	target := NewTarget(client)
	artifacts := SavedArtifacts{
		Queries: []SavedQuery{{Name: "Existing", SQL: "SELECT 'seed query'"}, {Name: "New", SQL: "SELECT 1"}},
		Graphs:  []graph.Definition{{Name: "Existing", EdgesSQL: "SELECT 1,2", Directed: true}, {Name: "New", EdgesSQL: "SELECT 1,2", Directed: true}},
	}
	for range 2 {
		if err := target.SeedArtifacts(context.Background(), artifacts); err != nil {
			t.Fatal(err)
		}
	}
	if writes != 2 || len(queries) != 2 || len(files) != 2 {
		t.Fatalf("duplicates or overwrites: %d writes, %d queries, %d graphs", writes, len(queries), len(files))
	}
	if queries["Existing"] != "SELECT 'user query'" || !strings.Contains(string(files["/pond/graphs/Existing.json"]), "SELECT 1,3") {
		t.Fatal("existing definitions were changed")
	}
}
