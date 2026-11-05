package lake

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// EnsureSavedQuery creates a named query if none exists. Existing SQL is kept.
func (c *Client) EnsureSavedQuery(ctx context.Context, name, sql string) error {
	if strings.TrimSpace(name) == "" || strings.TrimSpace(sql) == "" {
		return fmt.Errorf("saved query needs name and sql")
	}
	page := ""
	seen := map[string]bool{}
	for {
		path := "/api/2.0/sql/queries"
		if page != "" {
			path += "?page_token=" + url.QueryEscape(page)
		}
		out, err := c.requestJSON(ctx, http.MethodGet, path, nil)
		if err != nil {
			return err
		}
		var queries []struct {
			Name string `json:"display_name"`
		}
		if raw := out["results"]; raw != nil {
			if err := json.Unmarshal(raw, &queries); err != nil {
				return err
			}
		}
		for _, query := range queries {
			if query.Name == name {
				return nil
			}
		}
		var next string
		if raw := out["next_page_token"]; raw != nil {
			if err := json.Unmarshal(raw, &next); err != nil {
				return err
			}
		}
		if next == "" {
			break
		}
		if seen[next] {
			return fmt.Errorf("saved query listing repeats a page token")
		}
		seen[next] = true
		page = next
	}
	warehouse, err := c.WarehouseID(ctx)
	if err != nil {
		return err
	}
	_, err = c.requestJSON(ctx, http.MethodPost, "/api/2.0/sql/queries", map[string]any{"query": map[string]string{"display_name": name, "query_text": sql, "warehouse_id": warehouse}})
	return err
}
