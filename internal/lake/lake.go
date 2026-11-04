// Package lake is a thin client for the few MiniLake calls Pond makes itself.
package lake

import (
	"bytes"
	"context"
	"encoding/json"
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
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
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
