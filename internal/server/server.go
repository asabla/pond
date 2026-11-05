// Package server serves the static UI and proxies everything MiniLake owns
// (`/api`, `/_minilake`, `/mcp`) to the MiniLake process. Proxying keeps the
// browser same-origin and gives MCP clients a single URL for both the UI and
// the tools.
package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/asabla/pond/internal/lake"
)

var proxyPrefixes = []string{"/api/", "/_minilake/", "/mcp"}

// Options configures the handler New returns.
type Options struct {
	Host string // bind host, accepted in the Host header alongside loopback names
	// Extra names accepted in the Host header, such as the machine's addresses when shared.
	AllowedHosts []string
	Lake         *lake.Client
	Context      any    // describes the managed context, if any
	DataRoot     string // MiniLake's data directory as SQL sees it; empty when not managed
	Static       fs.FS
	Version      string
	// Peers lists the contexts the UI can switch to, this one included. Nil means none.
	Peers func() []Peer
}

// Peer is a context the UI can open alongside this one.
type Peer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Dir     string `json:"dir"`
	Running bool   `json:"running"`
	UI      string `json:"ui,omitempty"`     // where its pond serves, while it runs
	Status  string `json:"status,omitempty"` // Docker's status for its MiniLake container
	Self    bool   `json:"self"`             // the context this pond serves
}

// peerPrefixes are the paths /ctx/<id>/ passes on to another context's pond: its lake
// and its config, but not its MCP endpoint, which belongs to that context's agents.
var peerPrefixes = []string{"/api/", "/_minilake/", "/pond/config"}

type handler struct {
	Options
	allowed   map[string]bool
	proxy     *httputil.ReverseProxy
	transport *http.Transport
}

// New returns pond's HTTP handler: the embedded UI, /pond/config, and a proxy to
// MiniLake for /api, /_minilake and /mcp. It refuses requests for unknown hosts.
func New(o Options) http.Handler {
	target := o.Lake.Target()
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if dt, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = dt.Clone()
	}
	transport.DisableCompression = true // pass bodies through untouched
	transport.ResponseHeaderTimeout = 300 * time.Second
	h := &handler{
		Options:   o,
		transport: transport,
		allowed:   map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true, strings.ToLower(o.Host): true},
		proxy: &httputil.ReverseProxy{
			Rewrite: func(r *httputil.ProxyRequest) {
				r.SetURL(target)
				// MiniLake's MCP endpoint validates Origin against its own host.
				r.Out.Header.Del("Origin")
			},
			Transport: transport,
			// Flush every write so MCP's server-sent events arrive as they are produced.
			FlushInterval: -1,
			ErrorLog:      log.New(discard{}, "", 0),
			ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
				sendJSON(w, http.StatusBadGateway, map[string]string{
					"error_code": "MINILAKE_UNREACHABLE",
					"message":    fmt.Sprintf("%s: %v", o.Lake.URL(), err),
				})
			},
		},
	}
	for _, name := range o.AllowedHosts {
		h.allowed[strings.ToLower(strings.Trim(name, "[]"))] = true
	}
	if os.Getenv("POND_VERBOSE") != "" {
		return logging(h)
	}
	return h
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %q", r.Method, r.URL.RequestURI()) //nolint:gosec // G706: %q escapes it, and only POND_VERBOSE logs
		next.ServeHTTP(w, r)
	})
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// MiniLake has no auth; refusing foreign Host headers blocks DNS-rebinding pages
	// from driving it through Pond.
	if host := strings.ToLower(hostname(r.Host)); !h.allowed[host] {
		sendJSON(w, http.StatusForbidden, map[string]string{
			"error_code": "FORBIDDEN", "message": fmt.Sprintf("Host %q not allowed", host),
		})
		return
	}
	p := r.URL.Path
	if p == "/pond/contexts" || strings.HasPrefix(p, "/ctx/") {
		if reason := crossSite(r); reason != "" {
			sendJSON(w, http.StatusForbidden, map[string]string{"error_code": "FORBIDDEN", "message": reason})
			return
		}
		if p == "/pond/contexts" {
			h.contexts(w, r)
		} else {
			h.peer(w, r)
		}
		return
	}
	for _, prefix := range proxyPrefixes {
		if strings.HasPrefix(p, prefix) {
			if reason := crossSite(r); reason != "" {
				sendJSON(w, http.StatusForbidden, map[string]string{"error_code": "FORBIDDEN", "message": reason})
				return
			}
			h.proxy.ServeHTTP(w, r)
			return
		}
	}
	switch {
	case p == "/pond/config" && r.Method == http.MethodGet:
		h.config(w, r)
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		h.static(w, p)
	default:
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error_code": "METHOD_NOT_ALLOWED", "message": r.Method})
	}
}

// crossSite says why r came from another web page, or "" when it didn't. Browsers send
// Origin and Sec-Fetch-Site and pages can't forge them, so this stops any site you visit
// from driving the lake through localhost. Clients outside a browser (MCP, curl) send
// neither and are let through.
func crossSite(r *http.Request) string {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(u.Host, r.Host) {
			return fmt.Sprintf("requests from %q are not allowed", origin)
		}
	}
	// Covers the requests that carry no Origin, such as no-cors GETs. Same-site still
	// means another origin, such as another port on localhost.
	if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" || site == "same-site" {
		return "requests from other sites are not allowed"
	}
	return ""
}

func hostname(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return strings.Trim(hostport, "[]")
}

func (h *handler) contexts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error_code": "METHOD_NOT_ALLOWED", "message": r.Method})
		return
	}
	peers := []Peer{}
	if h.Peers != nil {
		peers = append(peers, h.Peers()...)
	}
	sendJSON(w, http.StatusOK, map[string]any{"contexts": peers})
}

// peer serves /ctx/<id>/<path>: this context's own requests are handled here, and
// another running context's go to its pond, which talks to its lake.
func (h *handler) peer(w http.ResponseWriter, r *http.Request) {
	escaped := strings.TrimPrefix(r.URL.EscapedPath(), "/ctx/")
	id, rest, _ := strings.Cut(escaped, "/")
	rest = "/" + rest
	restPath, err := url.PathUnescape(rest)
	if err != nil || !slices.ContainsFunc(peerPrefixes, func(p string) bool { return strings.HasPrefix(restPath, p) }) {
		sendJSON(w, http.StatusNotFound, map[string]string{"error_code": "NOT_FOUND", "message": r.URL.Path})
		return
	}
	var found *Peer
	if h.Peers != nil {
		for _, p := range h.Peers() {
			if p.ID == id {
				found = &p
				break
			}
		}
	}
	switch {
	case found == nil:
		sendJSON(w, http.StatusNotFound, map[string]string{"error_code": "CONTEXT_NOT_FOUND", "message": fmt.Sprintf("No context %q", id)})
		return
	case found.Self:
		local := r.Clone(r.Context())
		local.URL.Path, local.URL.RawPath = restPath, rest
		h.ServeHTTP(w, local)
		return
	case !found.Running || found.UI == "":
		sendJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error_code": "CONTEXT_STOPPED", "message": fmt.Sprintf("%s is not running. Start it with `pond %s`", found.Name, found.Dir),
		})
		return
	}
	target, err := url.Parse(found.UI)
	if err != nil {
		sendJSON(w, http.StatusBadGateway, map[string]string{"error_code": "CONTEXT_UNREACHABLE", "message": err.Error()})
		return
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path, pr.Out.URL.RawPath = restPath, rest
			pr.Out.Host = target.Host
			// This pond checked the request came from its own page. The other pond would
			// see a foreign origin and refuse it, so drop the headers it checks.
			for _, name := range []string{"Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
				pr.Out.Header.Del(name)
			}
		},
		Transport:     h.transport,
		FlushInterval: -1,
		ErrorLog:      log.New(discard{}, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			sendJSON(w, http.StatusBadGateway, map[string]string{
				"error_code": "CONTEXT_UNREACHABLE", "message": fmt.Sprintf("%s: %v", found.Name, err),
			})
		},
	}
	proxy.ServeHTTP(w, r)
}

func (h *handler) config(w http.ResponseWriter, r *http.Request) {
	out := struct {
		MinilakeURL string  `json:"minilake_url"`
		Context     any     `json:"context"`
		WarehouseID *string `json:"warehouse_id"`
		MCP         *bool   `json:"mcp"`
		Error       *string `json:"error"`
		Version     string  `json:"version"`
		DataRoot    *string `json:"data_root"`
	}{MinilakeURL: h.Lake.URL(), Context: h.Context, Version: h.Version}
	if h.DataRoot != "" {
		out.DataRoot = &h.DataRoot
	}
	if id, err := h.Lake.WarehouseID(r.Context()); err != nil {
		msg := err.Error()
		out.Error = &msg
	} else {
		mcp := h.Lake.MCPEnabled(r.Context())
		out.WarehouseID, out.MCP = &id, &mcp
	}
	sendJSON(w, http.StatusOK, out)
}

func (h *handler) static(w http.ResponseWriter, urlPath string) {
	rel := "index.html"
	if urlPath != "/" && urlPath != "" {
		rel = strings.TrimPrefix(urlPath, "/")
	}
	// fs.ValidPath rejects "..", which is what blocks traversal out of the static tree.
	body, err := fs.ReadFile(h.Static, rel)
	if !fs.ValidPath(rel) || err != nil {
		sendJSON(w, http.StatusNotFound, map[string]string{"error_code": "NOT_FOUND", "message": urlPath})
		return
	}
	ctype := mime.TypeByExtension(path.Ext(rel))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(body) //nolint:gosec // G705: body is an embedded UI file, not user input
}

func sendJSON(w http.ResponseWriter, status int, payload any) {
	body, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	w.Write(body)
}
