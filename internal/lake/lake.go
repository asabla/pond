// Package lake is a thin client for the few MiniLake calls Pond makes itself.
package lake

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const warehouseName = "pond"

type Client struct {
	url    string
	target *url.URL
	http   *http.Client

	mu          sync.Mutex
	warehouseID string
}

func New(rawURL string) (*Client, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, fmt.Errorf("MiniLake URL must be http(s)://host[:port], got %q", rawURL)
	}
	return &Client{
		url:    strings.TrimRight(rawURL, "/"),
		target: &url.URL{Scheme: u.Scheme, Host: u.Host},
		http:   &http.Client{},
	}, nil
}

// URL is the base URL as configured, without a trailing slash.
func (c *Client) URL() string { return c.url }

// Target is the scheme and host requests are proxied to.
func (c *Client) Target() *url.URL { return c.target }

func (c *Client) requestJSON(ctx context.Context, method, path string, body any) (map[string]json.RawMessage, error) {
	return c.requestJSONTimeout(ctx, 10*time.Second, method, path, body)
}

func (c *Client) requestJSONTimeout(ctx context.Context, timeout time.Duration, method, path string, body any) (map[string]json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url+path, payload)
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		var e struct{ Message string }
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			return nil, &Error{Status: resp.StatusCode, Message: e.Message}
		}
		return nil, fmt.Errorf("%s %s -> %d: %q", method, path, resp.StatusCode, truncate(data, 300))
	}
	out := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Error is a MiniLake error response.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func truncate(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}

// WarehouseID reuses the first running warehouse, creating one when MiniLake has none.
//
// MiniLake rejects statements without a known warehouse, and warehouses do not
// survive a MiniLake restart, so the cached id is re-validated on each call.
func (c *Client) WarehouseID(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out, err := c.requestJSON(ctx, http.MethodGet, "/api/2.0/sql/warehouses", nil)
	if err != nil {
		return "", err
	}
	var list []struct {
		ID *string `json:"id"`
	}
	if raw, ok := out["warehouses"]; ok {
		if err := json.Unmarshal(raw, &list); err != nil {
			return "", err
		}
	}
	ids := make([]string, 0, len(list))
	for _, w := range list {
		if w.ID == nil {
			return "", fmt.Errorf("warehouse without id")
		}
		ids = append(ids, *w.ID)
	}
	for _, id := range ids {
		if id == c.warehouseID {
			return id, nil
		}
	}
	if len(ids) > 0 {
		c.warehouseID = ids[0]
		return c.warehouseID, nil
	}
	created, err := c.requestJSON(ctx, http.MethodPost, "/api/2.0/sql/warehouses", map[string]string{"name": warehouseName})
	if err != nil {
		return "", err
	}
	var id string
	if err := json.Unmarshal(created["id"], &id); err != nil || id == "" {
		return "", fmt.Errorf("created warehouse without id")
	}
	c.warehouseID = id
	return id, nil
}

// MCPEnabled reports whether MiniLake mounts /mcp.
func (c *Client) MCPEnabled(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url+"/mcp", nil)
	if err != nil {
		return false
	}
	// An MCP-less MiniLake answers 404; a mounted MCP endpoint rejects a bare GET differently.
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode != http.StatusNotFound
}

// Poll intervals for statements and runs; tests shorten them.
var (
	pollInterval    = 250 * time.Millisecond
	runPollInterval = time.Second
)

func sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// ExecSQL runs one statement on the context's warehouse and waits for it to finish.
func (c *Client) ExecSQL(ctx context.Context, statement string) error {
	warehouse, err := c.WarehouseID(ctx)
	if err != nil {
		return err
	}
	out, err := c.requestJSONTimeout(ctx, 60*time.Second, http.MethodPost, "/api/2.0/sql/statements",
		map[string]string{"warehouse_id": warehouse, "statement": statement, "wait_timeout": "30s"})
	for err == nil {
		var st struct {
			ID     string `json:"statement_id"`
			Status struct {
				State string
				Error *struct{ Message string }
			}
		}
		raw, _ := json.Marshal(out)
		if err := json.Unmarshal(raw, &st); err != nil {
			return err
		}
		switch st.Status.State {
		case "SUCCEEDED":
			return nil
		case "PENDING", "RUNNING":
			if err := sleep(ctx, pollInterval); err != nil {
				return err
			}
			out, err = c.requestJSON(ctx, http.MethodGet, "/api/2.0/sql/statements/"+url.PathEscape(st.ID), nil)
		default:
			if st.Status.Error != nil && st.Status.Error.Message != "" {
				return errors.New(st.Status.Error.Message)
			}
			return fmt.Errorf("statement %s", strings.ToLower(st.Status.State))
		}
	}
	return err
}

// CreateCatalog creates a Unity Catalog catalog. SQL can't: MiniLake's DuckDB has no CREATE CATALOG.
func (c *Client) CreateCatalog(ctx context.Context, name string, ifNotExists bool) error {
	if ifNotExists {
		out, err := c.requestJSON(ctx, http.MethodGet, "/api/2.1/unity-catalog/catalogs/"+url.PathEscape(name), nil)
		if err == nil && len(out) > 0 {
			return nil
		}
		var lerr *Error
		if err != nil && !(errors.As(err, &lerr) && lerr.Status == http.StatusNotFound) {
			return err
		}
	}
	_, err := c.requestJSON(ctx, http.MethodPost, "/api/2.1/unity-catalog/catalogs", map[string]string{"name": name})
	return err
}

// RunResult is how a Python run ended.
type RunResult struct {
	RunID int64
	OK    bool
	State string // result state, such as SUCCESS or FAILED
	Error string
	Logs  string
}

// RunPython saves source to the workspace at path, runs it once and waits for it to finish.
func (c *Client) RunPython(ctx context.Context, name, path, source string) (*RunResult, error) {
	dir := path[:strings.LastIndex(path, "/")]
	if _, err := c.requestJSON(ctx, http.MethodPost, "/api/2.0/workspace/mkdirs", map[string]string{"path": dir}); err != nil {
		return nil, err
	}
	if _, err := c.requestJSON(ctx, http.MethodPost, "/api/2.0/workspace/import", map[string]any{
		"path": path, "format": "SOURCE", "language": "PYTHON", "overwrite": true,
		"content": base64.StdEncoding.EncodeToString([]byte(source)),
	}); err != nil {
		return nil, err
	}
	out, err := c.requestJSON(ctx, http.MethodPost, "/api/2.2/jobs/runs/submit", map[string]any{
		"run_name": name,
		"tasks":    []any{map[string]any{"task_key": "main", "spark_python_task": map[string]string{"python_file": path}}},
	})
	if err != nil {
		return nil, err
	}
	var runID int64
	if err := json.Unmarshal(out["run_id"], &runID); err != nil {
		return nil, fmt.Errorf("run submitted without run_id")
	}
	for {
		out, err := c.requestJSON(ctx, http.MethodGet, fmt.Sprintf("/api/2.2/jobs/runs/get?run_id=%d", runID), nil)
		if err != nil {
			return nil, err
		}
		var run struct {
			State struct {
				LifeCycle string `json:"life_cycle_state"`
				Result    string `json:"result_state"`
				Message   string `json:"state_message"`
			}
			Tasks []struct {
				RunID int64 `json:"run_id"`
			}
		}
		raw, _ := json.Marshal(out)
		if err := json.Unmarshal(raw, &run); err != nil {
			return nil, err
		}
		switch run.State.LifeCycle {
		case "TERMINATED", "SKIPPED", "INTERNAL_ERROR":
			res := &RunResult{RunID: runID, State: run.State.Result, OK: run.State.Result == "SUCCESS", Error: run.State.Message}
			outputID := runID
			if len(run.Tasks) > 0 && run.Tasks[0].RunID != 0 {
				outputID = run.Tasks[0].RunID
			}
			if output, err := c.requestJSON(ctx, http.MethodGet, fmt.Sprintf("/api/2.2/jobs/runs/get-output?run_id=%d", outputID), nil); err == nil {
				var o struct{ Logs, Error string }
				raw, _ := json.Marshal(output)
				json.Unmarshal(raw, &o)
				res.Logs = o.Logs
				if o.Error != "" {
					res.Error = o.Error
				}
			}
			return res, nil
		}
		if err := sleep(ctx, runPollInterval); err != nil {
			return nil, err
		}
	}
}

// Reset wipes the lake: catalogs, tables, files, jobs, queries and secrets.
func (c *Client) Reset(ctx context.Context) error {
	_, err := c.requestJSONTimeout(ctx, 120*time.Second, http.MethodPost, "/_minilake/reset", nil)
	c.mu.Lock()
	c.warehouseID = "" // reset drops warehouses too
	c.mu.Unlock()
	return err
}
