package graph

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/asabla/pond/internal/lake"
	"github.com/dop251/goja"
)

type loadedGraph struct {
	g        goja.Value
	total    int
	rows     int
	scope    string
	weighted bool
	columns  map[string]any
}

func (s *Service) load(ctx context.Context, e *engine, def Definition, scope string, sqlPath bool) (*loadedGraph, error) {
	budget := MaxBytes
	query := func(builder string, maxRows int, args ...any) (*lake.SQLResult, error) {
		sql, err := e.sql(builder, args...)
		if err != nil {
			return nil, err
		}
		res, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+sql, maxRows, budget)
		if err != nil {
			return nil, err
		}
		budget -= res.Bytes
		return res, nil
	}
	head, err := query("columnsSql", 0, def)
	if err != nil {
		return nil, err
	}
	if len(head.Columns) < 2 {
		return nil, fmt.Errorf("edge query needs at least two columns")
	}
	count, err := query("countEdgesSql", 1, def)
	if err != nil {
		return nil, err
	}
	if len(count.Rows) != 1 || len(count.Rows[0]) == 0 {
		return nil, fmt.Errorf("edge count query returned no count")
	}
	total, err := strconv.Atoi(fmt.Sprint(count.Rows[0][0]))
	if err != nil {
		return nil, fmt.Errorf("invalid edge count: %w", err)
	}
	l := &loadedGraph{total: total, scope: scope, columns: map[string]any{"source": head.Columns[0].Name, "target": head.Columns[1].Name}}
	for _, col := range head.Columns[2:] {
		if equalWeight(col.Name) {
			l.weighted = true
		}
	}
	if total > MaxEdges && sqlPath {
		l.scope = "full_sql"
		return l, nil
	}
	if total > MaxEdges && scope == "full" {
		return nil, fmt.Errorf("graph has %d source edge rows; complete analysis permits %d. Narrow the SQL or request scope overview", total, MaxEdges)
	}
	constructor := e.vm.Get("graphology")
	if v := constructor.ToObject(e.vm).Get("Graph"); !goja.IsUndefined(v) && v != nil {
		constructor = v
	}
	l.g, err = e.call("createGraph", constructor, def.Directed)
	if err != nil {
		return nil, err
	}
	add := func(rows *lake.SQLResult) error {
		records, err := e.call("edgeRecords", rows)
		if err != nil {
			return err
		}
		_, err = e.call("addEdges", l.g, records, l.weighted)
		l.rows = len(rows.Rows)
		return err
	}
	if total <= MaxEdges {
		l.scope = "full"
		rows, err := query("loadEdgesSql", MaxEdges, def, MaxEdges+1)
		if err != nil {
			return nil, err
		}
		if len(rows.Rows) != total {
			return nil, fmt.Errorf("graph changed during loading; run the analysis again")
		}
		if err := add(rows); err != nil {
			return nil, err
		}
	} else {
		top, err := query("topNodesSql", 20, def, l.columns, 20)
		if err != nil {
			return nil, err
		}
		ids := []any{}
		for _, row := range top.Rows {
			ids = append(ids, row[0])
			if _, err := e.call("ensureNode", l.g, row[0]); err != nil {
				return nil, err
			}
		}
		if len(ids) > 0 {
			touching, err := query("edgesTouchingSql", 500, def, l.columns, ids, 500)
			if err != nil {
				return nil, err
			}
			seen := map[string]bool{}
			for _, id := range ids {
				seen[fmt.Sprint(id)] = true
			}
			for _, row := range touching.Rows {
				if len(row) < 2 || row[0] == nil || row[1] == nil {
					continue
				}
				for _, id := range row[:2] {
					if id != nil && !seen[fmt.Sprint(id)] {
						seen[fmt.Sprint(id)] = true
						ids = append(ids, id)
					}
				}
			}
			among, err := query("edgesAmongSql", MaxEdges, def, l.columns, ids, MaxEdges)
			if err != nil {
				return nil, err
			}
			if err := add(among); err != nil {
				return nil, err
			}
		}
	}
	if def.NodesSQL != "" {
		var filter any
		if l.scope != "full" {
			nhead, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+"SELECT * FROM (\n"+def.NodesSQL+"\n) AS n LIMIT 0", 0, budget)
			if err != nil {
				return nil, err
			}
			if len(nhead.Columns) == 0 {
				return nil, fmt.Errorf("node query needs an id column")
			}
			g := l.g.ToObject(e.vm)
			fn, _ := goja.AssertFunction(g.Get("nodes"))
			keys, err := fn(g)
			if err != nil {
				return nil, err
			}
			ids := keys
			if keys.ToObject(e.vm).Get("length").ToInteger() == 0 {
				return l, nil
			}
			filter = map[string]any{"column": nhead.Columns[0].Name, "values": ids.Export()}
		}
		nodes, err := query("nodesSql", MaxNodes, def, filter)
		if err != nil {
			return nil, err
		}
		records, err := e.call("nodeRecords", nodes)
		if err != nil {
			return nil, err
		}
		if _, err := e.call("addNodes", l.g, records, l.scope != "full"); err != nil {
			return nil, err
		}
	}
	if l.g.ToObject(e.vm).Get("order").ToInteger() > MaxNodes {
		return nil, fmt.Errorf("graph exceeds %d nodes", MaxNodes)
	}
	return l, nil
}

func equalWeight(s string) bool { return strings.EqualFold(s, "weight") }

func (s *Service) sqlPath(ctx context.Context, e *engine, def Definition, columns map[string]any, from, to string) (any, error) {
	// Verify endpoints even when start and end are the same, including isolated nodes.
	for _, id := range []string{from, to} {
		sql, err := e.sql("neighborsSql", def, columns, id, 1)
		if err != nil {
			return nil, err
		}
		res, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+sql, 1, MaxBytes)
		if err != nil {
			return nil, err
		}
		if len(res.Rows) == 0 && def.NodesSQL != "" {
			head, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+"SELECT * FROM (\n"+def.NodesSQL+"\n) AS n LIMIT 0", 0, MaxBytes)
			if err != nil {
				return nil, err
			}
			if len(head.Columns) == 0 {
				return nil, fmt.Errorf("node query needs an id column")
			}
			sql, err = e.sql("nodesSql", def, map[string]any{"column": head.Columns[0].Name, "values": []string{id}})
			if err != nil {
				return nil, err
			}
			res, err = s.lake.QuerySQL(ctx, "/* pond:system */ "+sql, MaxNodes, MaxBytes)
			if err != nil {
				return nil, err
			}
		}
		if len(res.Rows) == 0 {
			return nil, fmt.Errorf("no node %q in the graph", id)
		}
	}
	options, err := e.value(map[string]any{"def": def, "columns": columns, "from": from, "to": to, "directed": def.Directed})
	if err != nil {
		return nil, err
	}
	budget := MaxBytes
	if err := options.ToObject(e.vm).Set("runSql", func(call goja.FunctionCall) goja.Value {
		rows, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+call.Argument(0).String(), 1000000, budget)
		if err != nil {
			panic(e.vm.NewGoError(err))
		}
		budget -= rows.Bytes
		value, err := e.value(rows)
		if err != nil {
			panic(e.vm.NewGoError(err))
		}
		return value
	}); err != nil {
		return nil, err
	}
	value, err := e.call("sqlShortestPath", options)
	if err != nil {
		return nil, err
	}
	promise, ok := value.Export().(*goja.Promise)
	if !ok || promise.State() == goja.PromiseStatePending {
		return nil, fmt.Errorf("SQL path search did not finish")
	}
	if promise.State() == goja.PromiseStateRejected {
		return nil, fmt.Errorf("SQL path search: %s", promise.Result())
	}
	var ids []any
	if err := e.export(promise.Result(), &ids); err != nil {
		return nil, err
	}
	if ids == nil {
		return nil, nil
	}
	nodes := make([]map[string]any, len(ids))
	for i, id := range ids {
		nodes[i] = map[string]any{"node": id, "label": fmt.Sprint(id)}
	}
	if def.NodesSQL != "" {
		head, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+"SELECT * FROM (\n"+def.NodesSQL+"\n) AS n LIMIT 0", 0, budget)
		if err != nil {
			return nil, err
		}
		if len(head.Columns) == 0 {
			return nil, fmt.Errorf("node query needs an id column")
		}
		sql, err := e.sql("nodesSql", def, map[string]any{"column": head.Columns[0].Name, "values": ids})
		if err != nil {
			return nil, err
		}
		rows, err := s.lake.QuerySQL(ctx, "/* pond:system */ "+sql, MaxNodes, budget)
		if err != nil {
			return nil, err
		}
		records, err := e.call("nodeRecords", rows)
		if err != nil {
			return nil, err
		}
		var labels []struct {
			ID    any    `json:"id"`
			Label string `json:"label"`
		}
		if err := e.export(records, &labels); err != nil {
			return nil, err
		}
		byID := map[string]string{}
		for _, row := range labels {
			byID[fmt.Sprint(row.ID)] = row.Label
		}
		for _, node := range nodes {
			if label, ok := byID[fmt.Sprint(node["node"])]; ok {
				node["label"] = label
			}
		}
	}
	return map[string]any{"nodes": nodes, "hops": len(ids) - 1, "weight": nil, "weighted": false}, nil
}
