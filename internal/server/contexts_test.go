package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/asabla/pond/internal/lake"
	"github.com/asabla/pond/internal/pondctx"
)

func TestForgetContextOnlyRemovesStoppedKnownPeers(t *testing.T) {
	client, _ := lake.New("http://127.0.0.1:1")
	for _, tc := range []struct {
		name, method, id, origin string
		err                      error
		status                   int
		called                   bool
	}{
		{name: "stopped", method: "DELETE", id: "old", status: 204, called: true},
		{name: "unknown is idempotent", method: "DELETE", id: "unknown", status: 204},
		{name: "running", method: "DELETE", id: "live", status: 409},
		{name: "self", method: "DELETE", id: "self", status: 409},
		{name: "wrong method", method: "POST", id: "old", status: 405},
		{name: "cross origin", method: "DELETE", id: "old", origin: "https://other.example", status: 403},
		{name: "startup race", method: "DELETE", id: "old", err: pondctx.ErrRunning, status: 409, called: true},
		{name: "registry failure", method: "DELETE", id: "old", err: errors.New("registry is read-only"), status: 500, called: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			h := New(Options{Lake: client, Peers: func() []Peer {
				return []Peer{{ID: "old", Dir: "/test/old"}, {ID: "live", Running: true}, {ID: "self", Self: true}}
			}, ForgetContext: func(dir string) error {
				called = true
				if dir != "/test/old" {
					t.Errorf("untrusted directory: %q", dir)
				}
				return tc.err
			}})
			r := httptest.NewRequest(tc.method, "http://localhost/pond/contexts/"+tc.id, nil)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || called != tc.called {
				t.Fatalf("got status %d, called %v: %s", w.Code, called, w.Body.String())
			}
		})
	}
}

func TestForgetContextRejectsOtherSiteWithoutOrigin(t *testing.T) {
	client, _ := lake.New("http://127.0.0.1:1")
	h := New(Options{Lake: client})
	r := httptest.NewRequest(http.MethodDelete, "http://localhost/pond/contexts/old", nil)
	r.Header.Set("Sec-Fetch-Site", "same-site")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-site mutation accepted: %d", w.Code)
	}
}
