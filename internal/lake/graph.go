package lake

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// SQLResult contains all available inline result chunks. Incomplete data is an error.
type SQLResult struct {
	Columns []Column `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Bytes   int      `json:"-"`
}

// Column describes a SQL result column.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// QuerySQL runs SQL and reads its result within the supplied row and byte bounds.
func (c *Client) QuerySQL(ctx context.Context, statement string, maxRows, maxBytes int) (*SQLResult, error) {
	warehouse, err := c.WarehouseID(ctx)
	if err != nil {
		return nil, err
	}
	out, err := c.requestJSONTimeout(ctx, 60*time.Second, http.MethodPost, "/api/2.0/sql/statements", map[string]string{"warehouse_id": warehouse, "statement": statement, "wait_timeout": "30s"})
	var result struct {
		ID     string `json:"statement_id"`
		Status struct {
			State string
			Error *struct{ Message string }
		}
		Manifest struct {
			Schema struct {
				Columns []struct {
					Name string
					Type string `json:"type_text"`
				}
			}
			Truncated bool
			TotalRows int `json:"total_row_count"`
		}
		Result sqlChunk
	}
	for err == nil {
		data, marshalErr := json.Marshal(out)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if err = json.Unmarshal(data, &result); err != nil {
			return nil, err
		}
		switch result.Status.State {
		case "SUCCEEDED":
			return c.readChunks(ctx, result.ID, result.Result, result.Manifest.Truncated, result.Manifest.TotalRows, result.Manifest.Schema.Columns, maxRows, maxBytes)
		case "PENDING", "RUNNING":
			if err = sleep(ctx, pollInterval); err != nil {
				return nil, err
			}
			out, err = c.requestJSON(ctx, http.MethodGet, "/api/2.0/sql/statements/"+url.PathEscape(result.ID), nil)
		default:
			if result.Status.Error != nil {
				return nil, fmt.Errorf("SQL: %s", result.Status.Error.Message)
			}
			return nil, fmt.Errorf("SQL statement %s", result.Status.State)
		}
	}
	return nil, err
}

type sqlChunk struct {
	Rows      json.RawMessage `json:"data_array"`
	Truncated bool            `json:"truncated"`
	Next      *int            `json:"next_chunk_index"`
	NextLink  string          `json:"next_chunk_internal_link"`
}

func (c *Client) readChunks(ctx context.Context, id string, chunk sqlChunk, truncated bool, total int, columns []struct {
	Name string
	Type string `json:"type_text"`
}, maxRows, maxBytes int) (*SQLResult, error) {
	res := &SQLResult{Columns: []Column{}, Rows: [][]any{}}
	for _, col := range columns {
		res.Columns = append(res.Columns, Column{Name: col.Name, Type: col.Type})
	}
	seen := map[int]bool{0: true}
	for {
		res.Bytes += len(chunk.Rows)
		if res.Bytes > maxBytes {
			return nil, fmt.Errorf("graph row data exceeds %d bytes", maxBytes)
		}
		var rows [][]any
		decoder := json.NewDecoder(bytes.NewReader(chunk.Rows))
		decoder.UseNumber()
		if len(chunk.Rows) > 0 && string(chunk.Rows) != "null" {
			if err := decoder.Decode(&rows); err != nil {
				return nil, err
			}
		}
		// Keep integer ids outside JavaScript's exact range as strings.
		for _, row := range rows {
			for i, v := range row {
				if n, ok := v.(json.Number); ok {
					f, err := strconv.ParseFloat(n.String(), 64)
					if err != nil {
						return nil, err
					}
					if !strings.ContainsAny(n.String(), ".eE") && (f > 9007199254740991 || f < -9007199254740991) {
						row[i] = n.String()
					} else {
						row[i] = f
					}
				}
			}
		}
		res.Rows = append(res.Rows, rows...)
		if len(res.Rows) > maxRows {
			return nil, fmt.Errorf("graph query exceeds %d rows", maxRows)
		}
		truncated = truncated || chunk.Truncated
		if chunk.Next == nil && chunk.NextLink != "" {
			prefix := "/api/2.0/sql/statements/" + url.PathEscape(id) + "/result/chunks/"
			link, err := url.Parse(chunk.NextLink)
			if err != nil || link.IsAbs() || link.Host != "" || link.RawQuery != "" || !strings.HasPrefix(link.Path, prefix) {
				return nil, fmt.Errorf("SQL result has an invalid chunk link")
			}
			index, err := strconv.Atoi(strings.TrimPrefix(link.Path, prefix))
			if err != nil {
				return nil, fmt.Errorf("SQL result has an invalid chunk index")
			}
			chunk.Next = &index
		}
		if chunk.Next == nil {
			break
		}
		index := *chunk.Next
		if seen[index] || index < 0 {
			return nil, fmt.Errorf("SQL result repeats a chunk")
		}
		seen[index] = true
		out, err := c.requestJSON(ctx, http.MethodGet, "/api/2.0/sql/statements/"+url.PathEscape(id)+"/result/chunks/"+strconv.Itoa(index), nil)
		if err != nil {
			return nil, err
		}
		data, err := json.Marshal(out)
		if err != nil {
			return nil, err
		}
		chunk = sqlChunk{}
		if err := json.Unmarshal(data, &chunk); err != nil {
			return nil, err
		}
	}
	if truncated || (total > 0 && total != len(res.Rows)) {
		return nil, fmt.Errorf("SQL result is incomplete; narrow the graph SQL")
	}
	return res, nil
}

// FileEntry describes an entry in MiniLake's Files API.
type FileEntry struct {
	Path        string `json:"path"`
	IsDirectory bool   `json:"is_directory"`
}

// ListDir lists a lake directory.
func (c *Client) ListDir(ctx context.Context, path string) ([]FileEntry, error) {
	out, err := c.requestJSON(ctx, http.MethodGet, "/api/2.0/fs/directories/"+strings.TrimLeft(path, "/"), nil)
	if err != nil {
		return nil, err
	}
	var entries []FileEntry
	if raw := out["contents"]; raw != nil {
		err = json.Unmarshal(raw, &entries)
	}
	return entries, err
}

// ReadFile reads a lake file with a byte limit.
func (c *Client) ReadFile(ctx context.Context, path string, limit int64) ([]byte, error) {
	return c.fileRequest(ctx, http.MethodGet, path, nil, false, limit)
}

// WriteFile writes a lake file; overwrite must be explicit.
func (c *Client) WriteFile(ctx context.Context, path string, data []byte, overwrite bool) error {
	_, err := c.fileRequest(ctx, http.MethodPut, path, data, overwrite, 1<<20)
	return err
}

func (c *Client) fileRequest(ctx context.Context, method, path string, data []byte, overwrite bool, limit int64) ([]byte, error) {
	u := c.url + "/api/2.0/fs/files/" + strings.TrimLeft(path, "/")
	if method == http.MethodPut {
		u += "?overwrite=" + strconv.FormatBool(overwrite)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("lake file exceeds %d bytes", limit)
	}
	if resp.StatusCode >= 400 {
		return nil, &Error{Status: resp.StatusCode, Message: fmt.Sprintf("file %s: %s", path, truncate(body, 300))}
	}
	return body, nil
}
