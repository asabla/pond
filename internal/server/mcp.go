package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/asabla/pond/internal/graph"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Each downstream connection gets its own server and upstream session. No
// MiniLake session id, resource subscription, or client state is shared.
type mcpBridge struct {
	mu                                   sync.Mutex
	server                               *mcp.Server
	upstream                             *mcp.ClientSession
	downstream                           *mcp.ServerSession
	url                                  string
	closed                               bool
	tools, resources, templates, prompts []string
}

func (h *handler) newMCP() http.Handler {
	return mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		b := &mcpBridge{url: h.Lake.URL() + "/mcp"}
		b.server = mcp.NewServer(&mcp.Implementation{Name: "pond", Version: h.Version}, &mcp.ServerOptions{
			Instructions: "Pond adds pond_graph_* analysis tools. Graph calls select a saved name or an inline definition, without browser state. MiniLake tools, resources and prompts are forwarded when available.",
			InitializedHandler: func(_ context.Context, req *mcp.InitializedRequest) {
				b.mu.Lock()
				b.downstream = req.Session
				b.mu.Unlock()
				stop := func() bool { return false }
				if h.Lifecycle != nil {
					// The server lifetime is independent of this initialization request.
					//nolint:contextcheck // shutdown must follow the server lifetime
					stop = context.AfterFunc(h.Lifecycle, func() { _ = req.Session.Close() })
				}
				go func() { _ = req.Session.Wait(); stop(); b.close() }()
			},
			CompletionHandler: func(ctx context.Context, req *mcp.CompleteRequest) (*mcp.CompleteResult, error) {
				up, err := b.session(ctx)
				if err != nil {
					return nil, err
				}
				return up.Complete(ctx, req.Params)
			},
			SubscribeHandler: func(ctx context.Context, req *mcp.SubscribeRequest) error {
				up, err := b.session(ctx)
				if err != nil {
					return err
				}
				return up.Subscribe(ctx, req.Params)
			},
			UnsubscribeHandler: func(ctx context.Context, req *mcp.UnsubscribeRequest) error {
				up, err := b.session(ctx)
				if err != nil {
					return err
				}
				return up.Unsubscribe(ctx, req.Params)
			},
		})
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		h.addGraphTools(b.server, scheme+"://"+r.Host)
		b.server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
			return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
				if call, ok := req.(*mcp.CallToolRequest); ok && strings.HasPrefix(call.Params.Name, "pond_graph_") {
					var cancel context.CancelFunc
					ctx, cancel = context.WithTimeout(ctx, graph.Timeout)
					defer cancel()
				}
				if method == "tools/list" || method == "resources/list" || method == "resources/templates/list" || method == "prompts/list" {
					up, err := b.session(ctx)
					if err == nil {
						if err := up.Ping(ctx, nil); err != nil {
							b.failed(up, err)
							_, _ = b.session(ctx)
						}
					}
				}
				return next(ctx, method, req)
			}
		})
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		_, _ = b.session(ctx) // The Pond tools remain usable when upstream MCP is disabled.
		// An initialize request without notifications/initialized must not leak a session.
		time.AfterFunc(time.Minute, func() {
			b.mu.Lock()
			unused := b.downstream == nil
			b.mu.Unlock()
			if unused {
				b.close()
			}
		})
		return b.server
	}, &mcp.StreamableHTTPOptions{SessionTimeout: 5 * time.Minute})
}

func (b *mcpBridge) close() {
	b.mu.Lock()
	b.closed = true
	up := b.upstream
	b.upstream = nil
	b.mu.Unlock()
	if up != nil {
		_ = up.Close()
	}
}

func (b *mcpBridge) session(ctx context.Context) (*mcp.ClientSession, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, fmt.Errorf("MCP session is closed")
	}
	if b.upstream != nil {
		return b.upstream, nil
	}
	changed := func(ctx context.Context) { go b.refresh(ctx) }
	client := mcp.NewClient(&mcp.Implementation{Name: "pond", Version: "1"}, &mcp.ClientOptions{
		Capabilities:               &mcp.ClientCapabilities{},
		ToolListChangedHandler:     func(ctx context.Context, _ *mcp.ToolListChangedRequest) { changed(ctx) },
		ResourceListChangedHandler: func(ctx context.Context, _ *mcp.ResourceListChangedRequest) { changed(ctx) },
		PromptListChangedHandler:   func(ctx context.Context, _ *mcp.PromptListChangedRequest) { changed(ctx) },
		ResourceUpdatedHandler: func(ctx context.Context, req *mcp.ResourceUpdatedNotificationRequest) {
			_ = b.server.ResourceUpdated(ctx, req.Params)
		},
		ProgressNotificationHandler: func(ctx context.Context, req *mcp.ProgressNotificationClientRequest) {
			b.mu.Lock()
			down := b.downstream
			b.mu.Unlock()
			if down != nil {
				_ = down.NotifyProgress(ctx, req.Params)
			}
		},
	})
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if dt, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = dt.Clone()
	}
	transport.ResponseHeaderTimeout = 300 * time.Second
	up, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: b.url, HTTPClient: &http.Client{Transport: transport}}, nil)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("MiniLake MCP unavailable: %w", err)
	}
	if err := b.discover(ctx, up); err != nil {
		_ = up.Close()
		transport.CloseIdleConnections()
		return nil, err
	}
	b.upstream = up
	go func() {
		_ = up.Wait()
		transport.CloseIdleConnections()
		b.mu.Lock()
		if b.upstream == up {
			b.upstream = nil
		}
		b.mu.Unlock()
	}()
	return up, nil
}

func (b *mcpBridge) refresh(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.upstream != nil {
		_ = b.discover(ctx, b.upstream)
	}
}

func (b *mcpBridge) failed(up *mcp.ClientSession, err error) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	b.mu.Lock()
	if b.upstream == up {
		b.upstream = nil
	}
	b.mu.Unlock()
	_ = up.Close() // Reconnect before a later call; never repeat the failed operation.
}

func (b *mcpBridge) discover(ctx context.Context, up *mcp.ClientSession) error {
	var tools []*mcp.Tool
	for tool, err := range up.Tools(ctx, nil) {
		if err != nil {
			return err
		}
		if strings.HasPrefix(tool.Name, "pond_graph_") {
			return fmt.Errorf("upstream MCP tool uses reserved prefix: %s", tool.Name)
		}
		tools = append(tools, tool)
	}
	var resources []*mcp.Resource
	var templates []*mcp.ResourceTemplate
	var prompts []*mcp.Prompt
	caps := up.InitializeResult().Capabilities
	if caps.Resources != nil {
		for resource, err := range up.Resources(ctx, nil) {
			if err != nil {
				return err
			}
			resources = append(resources, resource)
		}
		for template, err := range up.ResourceTemplates(ctx, nil) {
			if err != nil {
				return err
			}
			templates = append(templates, template)
		}
	}
	if caps.Prompts != nil {
		for prompt, err := range up.Prompts(ctx, nil) {
			if err != nil {
				return err
			}
			prompts = append(prompts, prompt)
		}
	}
	b.server.RemoveTools(b.tools...)
	b.server.RemoveResources(b.resources...)
	b.server.RemoveResourceTemplates(b.templates...)
	b.server.RemovePrompts(b.prompts...)
	b.tools, b.resources, b.templates, b.prompts = nil, nil, nil, nil
	for _, tool := range tools {
		b.tools = append(b.tools, tool.Name)
		b.server.AddTool(tool, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			session, err := b.session(ctx)
			if err != nil {
				return nil, err
			}
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: req.Params.Name, Arguments: req.Params.Arguments, Meta: req.Params.Meta})
			b.failed(session, err)
			return result, err
		})
	}
	read := func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		session, err := b.session(ctx)
		if err != nil {
			return nil, err
		}
		result, err := session.ReadResource(ctx, req.Params)
		b.failed(session, err)
		return result, err
	}
	for _, resource := range resources {
		b.resources = append(b.resources, resource.URI)
		b.server.AddResource(resource, read)
	}
	for _, template := range templates {
		b.templates = append(b.templates, template.URITemplate)
		b.server.AddResourceTemplate(template, read)
	}
	for _, prompt := range prompts {
		b.prompts = append(b.prompts, prompt.Name)
		b.server.AddPrompt(prompt, func(ctx context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			session, err := b.session(ctx)
			if err != nil {
				return nil, err
			}
			result, err := session.GetPrompt(ctx, req.Params)
			b.failed(session, err)
			return result, err
		})
	}
	return nil
}

func (h *handler) addGraphTools(s *mcp.Server, base string) {
	type empty struct{}
	type named struct {
		Name string `json:"name"`
	}
	type saveInput struct {
		Definition graph.Definition `json:"definition"`
		Replace    bool             `json:"replace,omitempty"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "pond_graph_list", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: "List graph definitions saved in this Pond context."}, func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, map[string]any, error) {
		defs, err := h.graphs.List(ctx)
		return nil, map[string]any{"graphs": defs}, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "pond_graph_get", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: "Read a saved graph definition and its browser URL."}, func(ctx context.Context, _ *mcp.CallToolRequest, in named) (*mcp.CallToolResult, *graph.Saved, error) {
		saved, err := h.graphs.Get(ctx, in.Name)
		if err == nil {
			saved.URL = base + saved.URL
		}
		return nil, saved, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "pond_graph_save", InputSchema: graphInputSchema("save"), Description: "Save a graph definition. Replacing an existing graph requires replace=true. Edges are SQL with source and target in the first two columns, optional weight; nodes are optional SQL with id first and optional label."}, func(ctx context.Context, _ *mcp.CallToolRequest, in saveInput) (*mcp.CallToolResult, *graph.Saved, error) {
		saved, err := h.graphs.Save(ctx, in.Definition, in.Replace)
		if err == nil {
			saved.URL = base + saved.URL
		}
		return nil, saved, err
	})
	for _, operation := range []string{"stats", "metrics", "neighbors", "path"} {
		description := map[string]string{
			"stats":     "Graph size, density, average degree and connected components.",
			"metrics":   "Rank nodes by degree, in_degree, out_degree, pagerank, betweenness, closeness, eigenvector, hub, authority, clustering; or group by community, component, strong_component, attr:COLUMN. top defaults to 10 (maximum 100).",
			"neighbors": "Inspect the exact node id in node; return incoming/outgoing neighbours and degrees.",
			"path":      "Find a shortest path between exact node ids from and to. Weighted graphs use non-negative distances unless unweighted=true. Large graphs require unweighted=true and use whole-graph SQL search within 20 hops and 20000 frontier nodes. No path is null; reaching a limit is an error.",
		}[operation] + " Give exactly one of name or definition. Complete analysis is the default (30000 edge rows, 60000 nodes, 32 MiB); explicit scope=overview analyses a limited subgraph. Results state their scope."
		mcp.AddTool(s, &mcp.Tool{Name: "pond_graph_" + operation, InputSchema: graphInputSchema(operation), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: description}, func(ctx context.Context, _ *mcp.CallToolRequest, in graph.Request) (*mcp.CallToolResult, map[string]any, error) {
			result, err := h.graphs.Analyze(ctx, operation, in)
			return nil, result, err
		})
	}
}

func graphInputSchema(operation string) map[string]any {
	str := map[string]any{"type": "string", "minLength": 1}
	// Apply direction defaults in Definition.UnmarshalJSON. A nested schema
	// default makes the SDK create an absent definition alongside a saved name.
	definition := map[string]any{"type": "object", "properties": map[string]any{
		"name": str, "edges_sql": str, "nodes_sql": map[string]any{"type": "string"}, "directed": map[string]any{"type": "boolean", "description": "Defaults to true when omitted"},
	}, "required": []string{"edges_sql"}, "additionalProperties": false}
	if operation == "save" {
		definition["required"] = []string{"name", "edges_sql"}
		return map[string]any{"type": "object", "properties": map[string]any{"definition": definition, "replace": map[string]any{"type": "boolean"}}, "required": []string{"definition"}, "additionalProperties": false}
	}
	properties := map[string]any{"name": str, "definition": definition, "scope": map[string]any{"type": "string", "enum": []string{"full", "overview"}, "default": "full"}}
	schema := map[string]any{"type": "object", "properties": properties, "oneOf": []any{map[string]any{"type": "object", "required": []string{"name"}}, map[string]any{"type": "object", "required": []string{"definition"}}}, "additionalProperties": false}
	switch operation {
	case "metrics":
		properties["metric"] = str
		properties["top"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 10}
		schema["required"] = []string{"metric"}
	case "neighbors":
		properties["node"] = str
		schema["required"] = []string{"node"}
	case "path":
		properties["from"], properties["to"] = str, str
		properties["unweighted"] = map[string]any{"type": "boolean"}
		schema["required"] = []string{"from", "to"}
	}
	return schema
}
