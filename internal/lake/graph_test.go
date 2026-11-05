package lake

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQueryChunksBoundsAndPrecision(t *testing.T) {
	for _, scenario := range []string{"chunks", "truncated", "rows", "bytes", "repeat", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/2.0/sql/warehouses" {
					_, _ = w.Write([]byte(`{"warehouses":[{"id":"w"}]}`))
					return
				}
				if strings.Contains(r.URL.Path, "/result/chunks/") {
					next := ""
					if scenario == "repeat" {
						next = `,"next_chunk_index":1`
					}
					_, _ = w.Write([]byte(`{"data_array":[[9007199254740995]]` + next + `}`))
					return
				}
				next := `,"next_chunk_index":1`
				if scenario == "missing" {
					next = ""
				}
				truncated := "false"
				if scenario == "truncated" {
					truncated = "true"
				}
				_, _ = w.Write([]byte(`{"statement_id":"s","status":{"state":"SUCCEEDED"},"manifest":{"schema":{"columns":[{"name":"id","type_text":"BIGINT"}]},"total_row_count":2,"truncated":` + truncated + `},"result":{"data_array":[[9007199254740993]]` + next + `}}`))
			}))
			defer srv.Close()
			c, err := New(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			rows, bytes := 2, 1000
			if scenario == "rows" {
				rows = 1
			}
			if scenario == "bytes" {
				bytes = 2
			}
			result, err := c.QuerySQL(context.Background(), "SELECT id FROM t", rows, bytes)
			if scenario != "chunks" {
				if err == nil {
					t.Fatalf("expected %s failure", scenario)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Rows) != 2 || result.Rows[0][0] != "9007199254740993" || result.Rows[1][0] != "9007199254740995" {
				body, _ := json.Marshal(result)
				t.Fatalf("precision lost: %s", body)
			}
		})
	}
}
