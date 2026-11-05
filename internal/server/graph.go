package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/asabla/pond/internal/graph"
)

func (h *handler) graphHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), graph.Timeout)
	defer cancel()
	var result any
	var err error
	p := r.URL.Path
	switch {
	case p == "/pond/graphs" && r.Method == http.MethodGet:
		var defs []graph.Definition
		defs, err = h.graphs.List(ctx)
		result = map[string]any{"graphs": defs}
	case strings.HasPrefix(p, "/pond/graphs/") && r.Method == http.MethodGet:
		result, err = h.graphs.Get(ctx, strings.TrimPrefix(p, "/pond/graphs/"))
	case strings.HasPrefix(p, "/pond/graphs/") && r.Method == http.MethodPut:
		var body struct {
			Definition graph.Definition `json:"definition"`
			Replace    bool             `json:"replace"`
		}
		if !decodeGraph(w, r, &body) {
			return
		}
		body.Definition.Name = strings.TrimPrefix(p, "/pond/graphs/")
		result, err = h.graphs.Save(ctx, body.Definition, body.Replace)
	case strings.HasPrefix(p, "/pond/graph/") && r.Method == http.MethodPost:
		var body graph.Request
		if !decodeGraph(w, r, &body) {
			return
		}
		result, err = h.graphs.Analyze(ctx, strings.TrimPrefix(p, "/pond/graph/"), body)
	default:
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "unsupported graph operation or HTTP method"})
		return
	}
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error_code": "GRAPH_ERROR", "message": err.Error()})
		return
	}
	sendJSON(w, http.StatusOK, result)
}

func decodeGraph(w http.ResponseWriter, r *http.Request, body any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(body); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return false
	}
	return true
}
