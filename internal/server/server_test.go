package server

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/web"
)

// fakeMiniLake is just enough of MiniLake for Pond's own calls and the proxy.
type fakeMiniLake struct {
	mu         sync.Mutex
	warehouses []string
	seen       []seenRequest
	release    chan struct{} // gates the second SSE event of /mcp
}

type seenRequest struct {
	path    string
	body    map[string]any
	headers http.Header
}

func (f *fakeMiniLake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(status int, payload any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(payload)
	}
	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case "/api/2.0/sql/warehouses":
			list := []map[string]string{}
			for _, id := range f.warehouses {
				list = append(list, map[string]string{"id": id})
			}
			reply(200, map[string]any{"warehouses": list})
		case "/mcp":
			reply(406, map[string]string{"error": "needs session"})
		case "/_minilake/health":
			reply(200, map[string]string{"status": "ok"})
		default:
			reply(404, map[string]string{"detail": "Not Found"})
		}
		return
	}
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	f.seen = append(f.seen, seenRequest{r.URL.Path, body, r.Header.Clone()})
	switch r.URL.Path {
	case "/api/2.0/sql/warehouses":
		f.warehouses = append(f.warehouses, "wh1")
		reply(200, map[string]string{"id": "wh1"})
	case "/mcp":
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("mcp-session-id", "abc")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		io.WriteString(w, "event: message\ndata: first\n\n")
		w.(http.Flusher).Flush()
		if f.release != nil {
			f.mu.Unlock()
			<-f.release
			f.mu.Lock()
		}
		io.WriteString(w, "event: message\ndata: second\n\n")
	default:
		reply(200, map[string]any{"echo": body})
	}
}

type env struct {
	t        *testing.T
	fake     *fakeMiniLake
	upstream *httptest.Server
	pond     *httptest.Server
}

func setup(t *testing.T, context any, dataRoot string) *env {
	t.Helper()
	fake := &fakeMiniLake{}
	upstream := httptest.NewServer(fake)
	t.Cleanup(upstream.Close)
	client, err := lake.New(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	static, err := fs.Sub(web.FS, "static")
	if err != nil {
		t.Fatal(err)
	}
	pond := httptest.NewServer(New(Options{
		Host: "127.0.0.1", Lake: client, Context: context, DataRoot: dataRoot, Static: static, Version: "test",
	}))
	t.Cleanup(pond.Close)
	return &env{t, fake, upstream, pond}
}

func (e *env) client() *lake.Client {
	c, err := lake.New(e.upstream.URL)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

func (e *env) static() fs.FS {
	static, err := fs.Sub(web.FS, "static")
	if err != nil {
		e.t.Fatal(err)
	}
	return static
}

func (e *env) request(method, path string, body any, headers map[string]string) (*http.Response, []byte) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, e.pond.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func (e *env) config() map[string]any {
	e.t.Helper()
	_, body := e.request("GET", "/pond/config", nil, nil)
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		e.t.Fatal(err)
	}
	return out
}

func TestServesIndex(t *testing.T) {
	resp, body := setup(t, nil, "").request("GET", "/", nil, nil)
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("got %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
	}
	if !strings.Contains(string(body), "<title>Pond</title>") {
		t.Error("index.html missing title")
	}
}

func TestBlocksPathTraversal(t *testing.T) {
	e := setup(t, nil, "")
	// Go's client cleans paths, so send the request line raw.
	for _, target := range []string{"/../server.go", "/static/../../go.mod", "/%2e%2e/go.mod"} {
		conn, err := net.Dial("tcp", e.pond.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		io.WriteString(conn, "GET "+target+" HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d", target, resp.StatusCode)
		}
	}
	if resp, _ := e.request("GET", "/nope.js", nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing file: status %d", resp.StatusCode)
	}
}

func TestAcceptsAllowedHostsWhenShared(t *testing.T) {
	e := setup(t, nil, "")
	e.pond.Config.Handler = New(Options{Host: "0.0.0.0", AllowedHosts: []string{"192.168.1.5", "My-Mac.local"}, Lake: e.client(), Static: e.static()})
	for _, host := range []string{"192.168.1.5:8700", "my-mac.local:8700"} {
		if resp, _ := e.request("GET", "/", nil, map[string]string{"Host": host}); resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", host, resp.StatusCode)
		}
	}
	if resp, _ := e.request("GET", "/", nil, map[string]string{"Host": "attacker.example"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("attacker: status %d", resp.StatusCode)
	}
}

func TestHostFlagMatchesAnyCase(t *testing.T) {
	e := setup(t, nil, "")
	e.pond.Config.Handler = New(Options{Host: "MyBox", Lake: e.client(), Static: e.static()})
	if resp, _ := e.request("GET", "/", nil, map[string]string{"Host": "MyBox:8700"}); resp.StatusCode != http.StatusOK {
		t.Errorf("status %d", resp.StatusCode)
	}
}

func TestServesStaticFilesToHead(t *testing.T) {
	if resp, body := setup(t, nil, "").request("HEAD", "/app.js", nil, nil); resp.StatusCode != http.StatusOK || len(body) != 0 {
		t.Errorf("HEAD: status %d, %d body bytes", resp.StatusCode, len(body))
	}
}

func TestRejectsForeignHostHeader(t *testing.T) {
	e := setup(t, nil, "")
	if resp, _ := e.request("GET", "/", nil, map[string]string{"Host": "attacker.example"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("status %d", resp.StatusCode)
	}
	if resp, _ := e.request("GET", "/", nil, map[string]string{"Host": "localhost:9"}); resp.StatusCode != http.StatusOK {
		t.Errorf("localhost: status %d", resp.StatusCode)
	}
}

func TestConfigCreatesWarehouseOnce(t *testing.T) {
	e := setup(t, nil, "")
	if got := e.config()["warehouse_id"]; got != "wh1" {
		t.Fatalf("warehouse_id = %v", got)
	}
	e.config()
	creates := 0
	for _, s := range e.fake.seen {
		if s.path == "/api/2.0/sql/warehouses" {
			creates++
		}
	}
	if creates != 1 {
		t.Errorf("creates = %d", creates)
	}
}

func TestConfigReportsMCPAndVersion(t *testing.T) {
	cfg := setup(t, nil, "").config()
	if cfg["mcp"] != true || cfg["version"] != "test" || cfg["error"] != nil {
		t.Errorf("config = %v", cfg)
	}
}

func TestConfigIncludesContextAndDataRoot(t *testing.T) {
	if cfg := setup(t, nil, "").config(); cfg["context"] != nil || cfg["data_root"] != nil {
		t.Errorf("unmanaged config = %v", cfg)
	}
	ctx := map[string]any{"name": "proj", "id": "proj-abc123", "dir": "/x/proj", "container": "pond-proj-abc123-minilake"}
	cfg := setup(t, ctx, "/data").config()
	got, _ := json.Marshal(cfg["context"])
	want, _ := json.Marshal(ctx)
	if string(got) != string(want) || cfg["data_root"] != "/data" {
		t.Errorf("config = %v", cfg)
	}
}

func TestConfigReportsUnreachableLake(t *testing.T) {
	e := setup(t, nil, "")
	e.upstream.Close()
	cfg := e.config()
	if cfg["warehouse_id"] != nil || cfg["mcp"] != nil || cfg["error"] == nil {
		t.Errorf("config = %v", cfg)
	}
}

func TestProxiesAPIRequests(t *testing.T) {
	resp, body := setup(t, nil, "").request("POST", "/api/2.0/sql/statements", map[string]string{"statement": "SELECT 1"}, nil)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != `{"echo":{"statement":"SELECT 1"}}` {
		t.Errorf("got %d %s", resp.StatusCode, body)
	}
}

func TestProxiesUpstreamErrors(t *testing.T) {
	resp, body := setup(t, nil, "").request("GET", "/api/2.1/unity-catalog/nope", nil, nil)
	if resp.StatusCode != http.StatusNotFound || strings.TrimSpace(string(body)) != `{"detail":"Not Found"}` {
		t.Errorf("got %d %s", resp.StatusCode, body)
	}
}

func TestProxiesMCPStreamAndHeaders(t *testing.T) {
	e := setup(t, nil, "")
	e.fake.release = make(chan struct{})
	req, _ := http.NewRequest(http.MethodPost, e.pond.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Origin", "http://localhost:1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("mcp-session-id") != "abc" {
		t.Fatalf("got %d, session %q", resp.StatusCode, resp.Header.Get("mcp-session-id"))
	}
	// The first event must arrive while the upstream is still holding the stream open.
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadString('\n')
	if err != nil || line != "event: message\n" {
		t.Fatalf("first line %q, %v", line, err)
	}
	close(e.fake.release)
	rest, _ := io.ReadAll(br)
	if !strings.Contains(string(rest), "data: second") {
		t.Errorf("rest = %q", rest)
	}
	e.fake.mu.Lock()
	defer e.fake.mu.Unlock()
	if got := e.fake.seen[len(e.fake.seen)-1].headers; got.Get("Origin") != "" {
		t.Errorf("Origin forwarded: %v", got)
	}
}

func TestProxyDoesNotDuplicateServerOrDate(t *testing.T) {
	resp, _ := setup(t, nil, "").request("GET", "/_minilake/health", nil, nil)
	if n := len(resp.Header.Values("Date")); n != 1 {
		t.Errorf("Date headers = %d", n)
	}
}

func TestUnreachableMiniLakeIs502(t *testing.T) {
	e := setup(t, nil, "")
	e.upstream.Close()
	resp, body := e.request("GET", "/_minilake/health", nil, nil)
	var out map[string]string
	json.Unmarshal(body, &out)
	if resp.StatusCode != http.StatusBadGateway || out["error_code"] != "MINILAKE_UNREACHABLE" {
		t.Errorf("got %d %s", resp.StatusCode, body)
	}
}

func TestRejectsNonGETOutsideProxy(t *testing.T) {
	if resp, _ := setup(t, nil, "").request("POST", "/", nil, nil); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status %d", resp.StatusCode)
	}
}
