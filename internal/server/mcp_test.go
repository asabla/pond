package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/web"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func pondMCPFixture(t *testing.T, upstream http.Handler) (context.Context, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	up := httptest.NewServer(upstream)
	lakeClient, err := lake.New(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	static, err := fs.Sub(web.FS, "static")
	if err != nil {
		t.Fatal(err)
	}
	pond := httptest.NewServer(New(Options{Lake: lakeClient, Static: static, Version: "test", Lifecycle: ctx}))
	t.Cleanup(func() { cancel(); pond.Close(); up.Close() })
	return ctx, pond.URL
}

func connectMCP(ctx context.Context, t *testing.T, endpoint string, opts *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, opts)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: endpoint + "/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func TestCombinedMCPDiscoveryForwardingAndSessions(t *testing.T) {
	var calls atomic.Int32
	up := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: "1"}, &mcp.ServerOptions{PageSize: 1})
	schema := map[string]any{"type": "object", "properties": map[string]any{}}
	for _, name := range []string{"echo", "fail", "wait"} {
		up.AddTool(&mcp.Tool{Name: name, Description: name, InputSchema: schema}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			calls.Add(1)
			if req.Params.Name == "wait" {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			if token := req.Params.GetProgressToken(); token != nil {
				_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Progress: 1, Total: 2})
			}
			return &mcp.CallToolResult{IsError: req.Params.Name == "fail", Content: []mcp.Content{&mcp.TextContent{Text: "upstream response"}}, StructuredContent: map[string]any{"session": req.Session.ID()}}, nil
		})
	}
	for _, uri := range []string{"minilake://one", "minilake://two"} {
		up.AddResource(&mcp.Resource{Name: uri, URI: uri}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, Text: "resource"}}}, nil
		})
	}
	up.AddResourceTemplate(&mcp.ResourceTemplate{Name: "table", URITemplate: "minilake://table/{name}"}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, Text: "template"}}}, nil
	})
	for _, name := range []string{"explore", "diagnose"} {
		up.AddPrompt(&mcp.Prompt{Name: name}, func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return &mcp.GetPromptResult{Description: req.Params.Name, Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: "prompt"}}}}, nil
		})
	}
	ctx, endpoint := pondMCPFixture(t, mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return up }, nil))
	progress := make(chan struct{}, 1)
	one := connectMCP(ctx, t, endpoint, &mcp.ClientOptions{ProgressNotificationHandler: func(context.Context, *mcp.ProgressNotificationClientRequest) {
		select {
		case progress <- struct{}{}:
		default:
		}
	}})
	two := connectMCP(ctx, t, endpoint, nil)
	tools := map[string]bool{}
	for tool, err := range one.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		tools[tool.Name] = true
	}
	if len(tools) != 10 || !tools["echo"] || !tools["pond_graph_metrics"] {
		t.Fatalf("tools: %v", tools)
	}
	params := &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{}}
	params.SetProgressToken("progress")
	first, err := one.CallTool(ctx, params)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-progress:
	case <-ctx.Done():
		t.Fatal("progress was not forwarded")
	}
	second, err := two.CallTool(ctx, &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(first.StructuredContent) == fmt.Sprint(second.StructuredContent) {
		t.Fatal("upstream sessions were shared")
	}
	if first.Content[0].(*mcp.TextContent).Text != "upstream response" {
		t.Fatalf("content: %v", first)
	}
	failure, err := one.CallTool(ctx, &mcp.CallToolParams{Name: "fail", Arguments: map[string]any{}})
	if err != nil || !failure.IsError {
		t.Fatalf("tool error lost: %v %v", failure, err)
	}
	resources, err := one.ListResources(ctx, nil)
	if err != nil || len(resources.Resources) != 2 {
		t.Fatalf("resources: %v %v", resources, err)
	}
	templates, err := one.ListResourceTemplates(ctx, nil)
	if err != nil || len(templates.ResourceTemplates) != 1 {
		t.Fatalf("templates: %v %v", templates, err)
	}
	resource, err := one.ReadResource(ctx, &mcp.ReadResourceParams{URI: "minilake://table/people"})
	if err != nil || resource.Contents[0].Text != "template" {
		t.Fatalf("read: %v %v", resource, err)
	}
	prompts, err := one.ListPrompts(ctx, nil)
	if err != nil || len(prompts.Prompts) != 2 {
		t.Fatalf("prompts: %v %v", prompts, err)
	}
	prompt, err := one.GetPrompt(ctx, &mcp.GetPromptParams{Name: "explore"})
	if err != nil || prompt.Description != "explore" {
		t.Fatalf("prompt: %v %v", prompt, err)
	}
	short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, err = one.CallTool(short, &mcp.CallToolParams{Name: "wait", Arguments: map[string]any{}})
	if err == nil {
		t.Fatal("cancellation did not stop the call")
	}
	if calls.Load() != 4 {
		t.Fatalf("unexpected retries: %d", calls.Load())
	}
}

func TestGraphMCPWithoutUpstreamMCP(t *testing.T) {
	ctx, endpoint := pondMCPFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			var def struct {
				Directed bool `json:"directed"`
			}
			if err := json.NewDecoder(r.Body).Decode(&def); err != nil {
				t.Error(err)
			}
			if !def.Directed {
				t.Error("omitted direction did not default to true")
			}
			_, _ = w.Write([]byte(`{}`))
			return
		}
		http.NotFound(w, r)
	}))
	session := connectMCP(ctx, t, endpoint, nil)
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 7 {
		t.Fatalf("graph tools unavailable: %v %v", tools, err)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "pond_graph_list", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("graph list unavailable: %v %v", result, err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "pond_graph_save", Arguments: map[string]any{"definition": map[string]any{"name": "Default direction", "edges_sql": "SELECT 1,2"}}})
	if err != nil || result.IsError {
		t.Fatalf("save without direction: %v %v", result, err)
	}
	for _, selector := range []map[string]any{{"name": "missing"}, {"definition": map[string]any{"edges_sql": "SELECT 1,2"}}} {
		result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "pond_graph_stats", Arguments: selector})
		if err != nil {
			t.Fatal(err)
		}
		if !result.IsError || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "validating") {
			t.Fatalf("selector %v: %s", selector, result.Content[0].(*mcp.TextContent).Text)
		}
	}
}

func TestMCPReconnectDiscoveryAndCleanup(t *testing.T) {
	closed := make(chan string, 4)
	up := mcp.NewServer(&mcp.Implementation{Name: "upstream", Version: "1"}, &mcp.ServerOptions{
		InitializedHandler: func(_ context.Context, req *mcp.InitializedRequest) {
			go func() { _ = req.Session.Wait(); closed <- req.Session.ID() }()
		},
	})
	var calls atomic.Int32
	up.AddTool(&mcp.Tool{Name: "disconnect", Description: "disconnect once", InputSchema: map[string]any{"type": "object"}}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls.Add(1)
		go func() { _ = req.Session.Close() }()
		return &mcp.CallToolResult{}, nil
	})
	ctx, endpoint := pondMCPFixture(t, mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return up }, nil))
	session := connectMCP(ctx, t, endpoint, nil)
	_, _ = session.CallTool(ctx, &mcp.CallToolParams{Name: "disconnect", Arguments: map[string]any{}})
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("upstream did not close")
	}
	up.AddTool(&mcp.Tool{Name: "after_restart", Description: "new discovery", InputSchema: map[string]any{"type": "object"}}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ready"}}}, nil
	})
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tool := range tools.Tools {
		found = found || tool.Name == "after_restart"
	}
	if !found {
		t.Fatal("reconnect did not refresh discovery")
	}
	if calls.Load() != 1 {
		t.Fatal("disconnected operation was retried")
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("downstream close leaked upstream session")
	}
}
