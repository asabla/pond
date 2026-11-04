package lake

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLake answers the MiniLake endpoints the client uses, recording each request.
type fakeLake struct {
	mu         sync.Mutex
	requests   []string
	warehouses []string
	catalogs   map[string]bool
	statements map[string]int // statement text -> polls before it succeeds; -1 fails
	polls      map[string]int
	runResult  string
	runPolls   int
	imported   string
}

func newFake(t *testing.T) (*fakeLake, *Client) {
	pollInterval, runPollInterval = time.Millisecond, time.Millisecond
	f := &fakeLake{catalogs: map[string]bool{}, statements: map[string]int{}, polls: map[string]int{}, runResult: "SUCCESS"}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := New(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

func send(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (f *fakeLake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	p := r.URL.Path
	switch {
	case p == "/api/2.0/sql/warehouses" && r.Method == "GET":
		list := []map[string]string{}
		for _, id := range f.warehouses {
			list = append(list, map[string]string{"id": id})
		}
		send(w, 200, map[string]any{"warehouses": list})
	case p == "/api/2.0/sql/warehouses" && r.Method == "POST":
		f.warehouses = append(f.warehouses, "wh1")
		send(w, 200, map[string]string{"id": "wh1"})
	case p == "/api/2.0/sql/statements" && r.Method == "POST":
		stmt := body["statement"].(string)
		f.polls[stmt] = f.statements[stmt]
		f.answerStatement(w, stmt)
	case strings.HasPrefix(p, "/api/2.0/sql/statements/"):
		f.answerStatement(w, strings.TrimPrefix(p, "/api/2.0/sql/statements/"))
	case strings.HasPrefix(p, "/api/2.1/unity-catalog/catalogs/"):
		name := strings.TrimPrefix(p, "/api/2.1/unity-catalog/catalogs/")
		if !f.catalogs[name] {
			send(w, 404, map[string]string{"error_code": "NOT_FOUND", "message": "Catalog '" + name + "' not found"})
			return
		}
		send(w, 200, map[string]string{"name": name})
	case p == "/api/2.1/unity-catalog/catalogs":
		name := body["name"].(string)
		if f.catalogs[name] {
			send(w, 409, map[string]string{"error_code": "ALREADY_EXISTS", "message": "Catalog '" + name + "' already exists"})
			return
		}
		f.catalogs[name] = true
		send(w, 200, map[string]string{"name": name})
	case p == "/api/2.0/workspace/mkdirs":
		send(w, 200, map[string]string{})
	case p == "/api/2.0/workspace/import":
		b, _ := base64.StdEncoding.DecodeString(body["content"].(string))
		f.imported = body["path"].(string) + ": " + string(b)
		send(w, 200, map[string]string{})
	case p == "/api/2.2/jobs/runs/submit":
		send(w, 200, map[string]int{"run_id": 42})
	case p == "/api/2.2/jobs/runs/get":
		state := map[string]string{"life_cycle_state": "RUNNING"}
		if f.runPolls--; f.runPolls < 0 {
			state = map[string]string{"life_cycle_state": "TERMINATED", "result_state": f.runResult, "state_message": "done"}
		}
		send(w, 200, map[string]any{"run_id": 42, "state": state, "tasks": []map[string]int{{"run_id": 43}}})
	case p == "/api/2.2/jobs/runs/get-output":
		out := map[string]string{"logs": "output of run " + r.URL.Query().Get("run_id")}
		if f.runResult != "SUCCESS" {
			out["error"] = "ValueError: bad"
		}
		send(w, 200, out)
	case p == "/_minilake/reset":
		f.warehouses = nil
		send(w, 200, map[string]string{})
	default:
		send(w, 404, map[string]string{"message": "no route " + p})
	}
}

// answerStatement treats the statement text as its id, to keep the fake simple.
func (f *fakeLake) answerStatement(w http.ResponseWriter, stmt string) {
	switch left := f.polls[stmt]; {
	case left < 0:
		send(w, 200, map[string]any{"statement_id": stmt, "status": map[string]any{"state": "FAILED", "error": map[string]string{"message": "Binder Error: no such table"}}})
	case left > 0:
		f.polls[stmt]--
		send(w, 200, map[string]any{"statement_id": stmt, "status": map[string]string{"state": "RUNNING"}})
	default:
		send(w, 200, map[string]any{"statement_id": stmt, "status": map[string]string{"state": "SUCCEEDED"}})
	}
}

func (f *fakeLake) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if strings.HasPrefix(r, prefix) {
			n++
		}
	}
	return n
}

func TestNewValidatesURL(t *testing.T) {
	for _, bad := range []string{"", "localhost:8000", "ftp://x", "http://"} {
		if _, err := New(bad); err == nil {
			t.Errorf("New(%q) accepted", bad)
		}
	}
	c, err := New("http://127.0.0.1:8000/")
	if err != nil || c.URL() != "http://127.0.0.1:8000" || c.Target().String() != "http://127.0.0.1:8000" {
		t.Errorf("c = %+v, %v", c, err)
	}
}

func TestWarehouseIDCreatesOnceAndReuses(t *testing.T) {
	f, c := newFake(t)
	for range 3 {
		if id, err := c.WarehouseID(context.Background()); err != nil || id != "wh1" {
			t.Fatalf("id = %q, %v", id, err)
		}
	}
	if n := f.count("POST /api/2.0/sql/warehouses"); n != 1 {
		t.Errorf("created %d warehouses", n)
	}
}

func TestExecSQLWaitsForTheStatement(t *testing.T) {
	f, c := newFake(t)
	f.statements["CREATE TABLE slow AS SELECT 1"] = 2
	if err := c.ExecSQL(context.Background(), "CREATE TABLE slow AS SELECT 1"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("GET /api/2.0/sql/statements/"); n != 2 {
		t.Errorf("polled %d times, want 2", n)
	}
}

func TestExecSQLReportsFailures(t *testing.T) {
	f, c := newFake(t)
	f.statements["SELECT * FROM missing"] = -1
	if err := c.ExecSQL(context.Background(), "SELECT * FROM missing"); err == nil || err.Error() != "Binder Error: no such table" {
		t.Errorf("err = %v", err)
	}
}

func TestErrorResponsesKeepMiniLakesMessage(t *testing.T) {
	f, c := newFake(t)
	f.catalogs["shop"] = true
	err := c.CreateCatalog(context.Background(), "shop", false)
	var lerr *Error
	if !errors.As(err, &lerr) || lerr.Status != 409 || lerr.Message != "Catalog 'shop' already exists" {
		t.Errorf("err = %#v", err)
	}
}

func TestCreateCatalogIfNotExists(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	if err := c.CreateCatalog(ctx, "shop", true); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateCatalog(ctx, "shop", true); err != nil {
		t.Errorf("second create with IF NOT EXISTS: %v", err)
	}
	if n := f.count("POST /api/2.1/unity-catalog/catalogs"); n != 1 {
		t.Errorf("POSTed %d times", n)
	}
}

func TestRunPythonWaitsAndCollectsOutput(t *testing.T) {
	f, c := newFake(t)
	f.runPolls = 2
	res, err := c.RunPython(context.Background(), "seed", "/Shared/pond/seed/gen.py", "print('hi')")
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.RunID != 42 || res.Logs != "output of run 43" {
		t.Errorf("res = %+v", res)
	}
	if f.imported != "/Shared/pond/seed/gen.py: print('hi')" {
		t.Errorf("imported %q", f.imported)
	}
}

func TestRunPythonReportsFailure(t *testing.T) {
	f, c := newFake(t)
	f.runResult = "FAILED"
	res, err := c.RunPython(context.Background(), "seed", "/Shared/x.py", "boom")
	if err != nil {
		t.Fatal(err)
	}
	if res.OK || res.State != "FAILED" || res.Error != "ValueError: bad" {
		t.Errorf("res = %+v", res)
	}
}

func TestResetForgetsTheWarehouse(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	c.WarehouseID(ctx)
	if err := c.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if c.warehouseID != "" {
		t.Error("cached warehouse kept after reset")
	}
	if id, err := c.WarehouseID(ctx); err != nil || id != "wh1" {
		t.Errorf("after reset: %q, %v", id, err)
	}
	if n := f.count("POST /api/2.0/sql/warehouses"); n != 2 {
		t.Errorf("created %d warehouses, want 2", n)
	}
}

func TestMCPEnabled(t *testing.T) {
	_, c := newFake(t)
	if c.MCPEnabled(context.Background()) {
		t.Error("404 /mcp reported as enabled")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "event: ok\n\n")
	}))
	defer srv.Close()
	c2, _ := New(srv.URL)
	if !c2.MCPEnabled(context.Background()) {
		t.Error("mounted /mcp reported as disabled")
	}
}
